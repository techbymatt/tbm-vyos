"use strict";

const REPOSITORIES = ["vyos-1x", "vyos-build"];
const PR_LIMIT = 15;
const FULL_SHA = /^[0-9a-f]{40}$/i;

function fullSha(value, description) {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw new Error(`Invalid full commit SHA for ${description}.`);
  }
  return value.toLowerCase();
}

function escapeMarkdown(value) {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_\[\]~|]/g, "\\$&");
}

function publicationOrder(left, right) {
  return Date.parse(left.published_at) - Date.parse(right.published_at) || left.id - right.id;
}

function previousPublishedRelease(releases, version) {
  const published = releases.filter((release) => !release.draft && release.published_at);
  const current = published.find((release) => release.tag_name === version);

  // On reruns, do not compare an existing release against itself or a newer release.
  return published
    .filter((release) => release.tag_name !== version && (!current || publicationOrder(release, current) < 0))
    .sort(publicationOrder)
    .at(-1);
}

function previousUpstreamShas(body = "") {
  const shas = {};
  const metadata = body.match(/<!--\s*tbm-vyos-upstream:\s*([\s\S]*?)-->/);
  if (metadata) {
    const parsed = JSON.parse(metadata[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid upstream revision metadata in the previous release.");
    }
    for (const repository of REPOSITORIES) {
      if (parsed[repository] !== undefined) {
        shas[repository] = fullSha(parsed[repository], `${repository} in the previous release`);
      }
    }
  }

  // Releases predating the metadata comment already contain upstream commit links.
  for (const repository of REPOSITORIES) {
    const link = body.match(new RegExp(
      `https://github\\.com/vyos/${repository}/commit/([0-9a-f]{7,40})(?![0-9a-f])`,
      "i",
    ));
    if (!shas[repository] && link) {
      shas[repository] = link[1].toLowerCase();
    }
  }
  return shas;
}

function requestedPrNumbers(value, repository) {
  const numbers = value.trim() ? value.trim().split(/\s+/) : [];
  if (numbers.some((number) => !/^[1-9][0-9]*$/.test(number) || !Number.isSafeInteger(Number(number)))) {
    throw new Error(`Expected whitespace-separated PR numbers for ${repository}.`);
  }
  return [...new Set(numbers.map(Number))];
}

async function compareCommits(github, repository, previous, current) {
  if (previous === current) {
    return { status: "identical", commits: [] };
  }

  const commits = [];
  for (let page = 1; ; page += 1) {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({
      owner: "vyos",
      repo: repository,
      basehead: `${previous}...${current}`,
      per_page: 100,
      page,
    });
    if (["behind", "diverged"].includes(data.status)) {
      return { status: data.status, commits: [] };
    }
    if (!["ahead", "identical"].includes(data.status) || !Number.isInteger(data.total_commits)) {
      throw new Error(`Unexpected commit comparison response for ${repository}.`);
    }

    // Explicit pagination avoids the compare endpoint's unpaginated 250-commit cap.
    commits.push(...data.commits);
    if (commits.length === data.total_commits) {
      return { status: data.status, commits };
    }
    if (!data.commits.length || commits.length > data.total_commits) {
      throw new Error(`Incomplete commit comparison for ${repository}.`);
    }
  }
}

async function mergedPullRequests(github, repository, commits) {
  const shas = new Set(commits.map((commit) => commit.sha));
  const pulls = new Map();
  for (const sha of shas) {
    const associated = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
      owner: "vyos",
      repo: repository,
      commit_sha: sha,
      per_page: 100,
    });
    for (const pull of associated) {
      // Associations can include open PRs, other branches, and already-included PRs.
      // The resulting merge/squash/rebase commit must itself be new in this release.
      if (
        pull.merged_at &&
        pull.base.ref === "rolling" &&
        pull.base.repo.full_name.toLowerCase() === `vyos/${repository}` &&
        shas.has(pull.merge_commit_sha)
      ) {
        pulls.set(pull.number, pull);
      }
    }
  }
  return [...pulls.values()].sort((left, right) =>
    Date.parse(right.merged_at) - Date.parse(left.merged_at) || right.number - left.number,
  );
}

function pullRequestLine(repository, pull) {
  return `- [#${pull.number}](https://github.com/vyos/${repository}/pull/${pull.number}) — ${escapeMarkdown(pull.title)}`;
}

async function repositoryChanges(github, repository, previous, current) {
  const lines = [`#### \`${repository}\``, ""];
  if (!previous) {
    lines.push("No previous upstream revision is recorded; this release establishes the baseline.");
    return lines.join("\n");
  }
  if (!FULL_SHA.test(previous)) {
    const { data } = await github.rest.repos.getCommit({ owner: "vyos", repo: repository, ref: previous });
    previous = fullSha(data.sha, `${repository} in the previous release`);
  }

  const comparison = `https://github.com/vyos/${repository}/compare/${previous}...${current}`;
  const { status, commits } = await compareCommits(github, repository, previous, current);
  if (["behind", "diverged"].includes(status)) {
    lines.push("⚠️ The upstream revision moved backwards or diverged from the previous release; a merged-PR summary is unavailable.");
  } else {
    const pulls = await mergedPullRequests(github, repository, commits);
    if (!pulls.length) {
      lines.push("No new merged PRs.");
    } else {
      if (pulls.length > PR_LIMIT) {
        lines.push(`Showing the latest ${PR_LIMIT} of ${pulls.length} merged PRs.`, "");
      }
      lines.push(...pulls.slice(0, PR_LIMIT).map((pull) => pullRequestLine(repository, pull)));
    }
  }
  lines.push("", `[Full comparison](${comparison})`);
  return lines.join("\n");
}

async function generateChangelog({ github, owner, repo, version, currentShas, requestedPrs = {} }) {
  const shas = {};
  const requested = {};
  for (const repository of REPOSITORIES) {
    shas[repository] = fullSha(currentShas[repository], repository);
    requested[repository] = requestedPrNumbers(requestedPrs[repository] || "", repository);
  }

  const releases = await github.paginate(github.rest.repos.listReleases, { owner, repo, per_page: 100 });
  const previous = previousPublishedRelease(releases, version);
  const previousShas = previousUpstreamShas(previous?.body || "");
  const lines = ["### Upstream Changes", ""];
  if (previous) {
    const url = `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(previous.tag_name)}`;
    lines.push(`Changes since [${escapeMarkdown(previous.tag_name)}](${url}).`);
  } else {
    lines.push("No previous published release was found. This release establishes an upstream baseline.");
  }
  for (const repository of REPOSITORIES) {
    lines.push("", await repositoryChanges(github, repository, previousShas[repository], shas[repository]));
  }

  if (REPOSITORIES.some((repository) => requested[repository].length)) {
    lines.push("", "### Additional PRs Included", "",
      "These PRs were explicitly requested for this build and may not yet be merged upstream.");
    for (const repository of REPOSITORIES) {
      if (!requested[repository].length) continue;
      lines.push("", `#### \`${repository}\``, "");
      for (const number of requested[repository]) {
        const { data } = await github.rest.pulls.get({ owner: "vyos", repo: repository, pull_number: number });
        lines.push(pullRequestLine(repository, data));
      }
    }
  }

  lines.push("", `<!-- tbm-vyos-upstream: ${JSON.stringify(shas)} -->`, "");
  return lines.join("\n");
}

module.exports = { generateChangelog, previousPublishedRelease, previousUpstreamShas };
