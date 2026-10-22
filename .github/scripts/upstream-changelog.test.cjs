"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  generateChangelog,
  previousPublishedRelease,
  previousUpstreamShas,
} = require("./upstream-changelog.cjs");

const sha = (number) => number.toString(16).padStart(40, "0");
const CURRENT = { "vyos-1x": sha(1000), "vyos-build": sha(2000) };
const PREVIOUS = { "vyos-1x": sha(999), "vyos-build": CURRENT["vyos-build"] };
const metadata = (shas) => `<!-- tbm-vyos-upstream: ${JSON.stringify(shas)} -->`;

function release(overrides = {}) {
  return {
    id: 1,
    tag_name: "2026.10.10",
    published_at: "2026-10-10T12:00:00Z",
    draft: false,
    body: metadata(PREVIOUS),
    ...overrides,
  };
}

function pull(repository, number, overrides = {}) {
  return {
    number,
    title: `Change ${number}`,
    merged_at: "2026-10-11T12:00:00Z",
    merge_commit_sha: sha(number),
    base: { ref: "rolling", repo: { full_name: `vyos/${repository}` } },
    ...overrides,
  };
}

function paginated(items, { page = 1, per_page = 100 }) {
  return {
    data: items.slice((page - 1) * per_page, page * per_page),
    headers: { link: page * per_page < items.length ? '<https://example.test>; rel="next"' : "" },
  };
}

function fakeGithub({ releases = [release()], comparisons = {}, associations = {}, commits = {}, pulls = {} } = {}) {
  const calls = [];
  const endpoint = (name, handler) => async (params) => {
    calls.push({ name, ...params });
    return handler(params);
  };
  const github = {
    rest: {
      repos: {
        listReleases: endpoint("listReleases", (params) => paginated(releases, params)),
        getCommit: endpoint("getCommit", ({ repo, ref }) => {
          assert.ok(commits[`${repo}/${ref}`], `Unexpected commit lookup: ${repo}/${ref}`);
          return { data: { sha: commits[`${repo}/${ref}`] } };
        }),
        compareCommitsWithBasehead: endpoint("compare", (params) => {
          const comparison = comparisons[params.repo];
          assert.ok(comparison, `Unexpected comparison: ${params.repo}`);
          if (comparison instanceof Error) throw comparison;
          return {
            data: {
              status: comparison.status || "ahead",
              total_commits: comparison.commits.length,
              commits: paginated(comparison.commits, params).data,
            },
          };
        }),
        listPullRequestsAssociatedWithCommit: endpoint("associated", (params) => {
          const associated = associations[`${params.repo}/${params.commit_sha}`] || [];
          if (associated instanceof Error) throw associated;
          return paginated(associated, params);
        }),
      },
      pulls: {
        get: endpoint("getPull", ({ repo, pull_number }) => {
          const requested = pulls[`${repo}/${pull_number}`];
          assert.ok(requested, `Unexpected PR lookup: ${repo}/${pull_number}`);
          return { data: requested };
        }),
      },
    },
    async paginate(method, params) {
      const items = [];
      for (let page = 1; ; page += 1) {
        const response = await method({ ...params, page });
        items.push(...response.data);
        if (!response.headers.link.includes('rel="next"')) return items;
      }
    },
  };
  return { github, calls };
}

function generate(github, overrides = {}) {
  return generateChangelog({
    github,
    owner: "techbymatt",
    repo: "tbm-vyos",
    version: "2026.10.15",
    currentShas: CURRENT,
    ...overrides,
  });
}

test("selects the previous release by publication time, not API or creation order", () => {
  const older = release({ id: 3, created_at: "2026-10-14T00:00:00Z" });
  const newer = release({ id: 2, tag_name: "2026.10.12", published_at: "2026-10-12T00:00:00Z" });
  const draft = release({ id: 4, draft: true, published_at: "2026-10-14T00:00:00Z" });
  const unpublished = release({ id: 5, published_at: null });
  assert.equal(previousPublishedRelease([newer, draft, older, unpublished], "2026.10.15"), newer);
});

test("reruns exclude the current tag and releases published after it", () => {
  const older = release();
  const current = release({ id: 2, tag_name: "2026.10.15", published_at: "2026-10-15T00:00:00Z" });
  const newer = release({ id: 3, tag_name: "2026.10.20", published_at: "2026-10-20T00:00:00Z" });
  assert.equal(previousPublishedRelease([newer, current, older], current.tag_name), older);
  assert.equal(previousPublishedRelease([current, newer], current.tag_name), undefined);
});

test("reads full-SHA metadata and gives it precedence over visible commit links", () => {
  const body = `https://github.com/vyos/vyos-1x/commit/abcdef0\n${metadata(PREVIOUS)}`;
  assert.deepEqual(previousUpstreamShas(body), PREVIOUS);
});

test("falls back to legacy links independently for each upstream repository", () => {
  const body = [
    metadata({ "vyos-1x": PREVIOUS["vyos-1x"] }),
    "https://github.com/vyos/vyos-build/commit/abcdef0",
  ].join("\n");
  assert.deepEqual(previousUpstreamShas(body), { "vyos-1x": PREVIOUS["vyos-1x"], "vyos-build": "abcdef0" });
  assert.deepEqual(previousUpstreamShas("No upstream links."), {});
});

test("malformed metadata fails rather than silently using an incorrect baseline", () => {
  assert.throws(() => previousUpstreamShas("<!-- tbm-vyos-upstream: not json -->"));
  assert.throws(() => previousUpstreamShas(metadata({ "vyos-1x": "abcdef0" })), /Invalid full commit SHA/);
  assert.throws(() => previousUpstreamShas(metadata([])), /Invalid upstream revision metadata/);
});

test("deduplicates, filters, and sorts PRs by merge time", async () => {
  const newest = pull("vyos-1x", 2, { merged_at: "2026-10-13T00:00:00Z" });
  const oldest = pull("vyos-1x", 1);
  const excluded = [
    pull("vyos-1x", 3, { merged_at: null }),
    pull("vyos-1x", 4, { base: { ref: "sagitta", repo: { full_name: "vyos/vyos-1x" } } }),
    pull("vyos-1x", 5, { merge_commit_sha: PREVIOUS["vyos-1x"] }),
    pull("another-repository", 6),
  ];
  const { github, calls } = fakeGithub({
    comparisons: { "vyos-1x": { commits: [1, 2, 3, 4, 5, 6].map((number) => ({ sha: sha(number) })) } },
    associations: {
      [`vyos-1x/${sha(1)}`]: [oldest, newest, ...excluded],
      [`vyos-1x/${sha(2)}`]: [newest],
    },
  });
  const markdown = await generate(github);
  assert.ok(markdown.indexOf("[#2]") < markdown.indexOf("[#1]"));
  assert.equal((markdown.match(/^- \[#/gm) || []).length, 2);
  for (const number of [3, 4, 5, 6]) assert.ok(!markdown.includes(`[#${number}]`));
  assert.ok(!markdown.includes("Showing the latest"));
  assert.ok(markdown.includes(`/compare/${PREVIOUS["vyos-1x"]}...${CURRENT["vyos-1x"]}`));
  assert.ok(markdown.includes("releases/tag/2026.10.10"));
  assert.equal(calls.find((call) => call.name === "compare").basehead, `${PREVIOUS["vyos-1x"]}...${CURRENT["vyos-1x"]}`);
});

test("lists all merged PRs for both repositories without truncation, newest first", async () => {
  const previous = { "vyos-1x": sha(900), "vyos-build": sha(1900) };
  const comparisons = {};
  const associations = {};
  for (const repository of Object.keys(CURRENT)) {
    const numbers = Array.from({ length: 17 }, (_, index) => index + 1);
    comparisons[repository] = { commits: numbers.map((number) => ({ sha: sha(number) })) };
    for (const number of numbers) {
      associations[`${repository}/${sha(number)}`] = [pull(repository, number, {
        merged_at: `2026-10-${String(number + 10).padStart(2, "0")}T00:00:00Z`,
      })];
    }
  }
  const { github } = fakeGithub({ releases: [release({ body: metadata(previous) })], comparisons, associations });
  const markdown = await generate(github);
  assert.ok(!markdown.includes("Showing the latest"));
  assert.equal((markdown.match(/^- \[#/gm) || []).length, 34);
  assert.equal((markdown.match(/\[Full comparison\]/g) || []).length, 2);
  for (const repository of Object.keys(CURRENT)) {
    assert.ok(markdown.includes(`#### \`${repository}\``));
    assert.ok(markdown.includes(`/compare/${previous[repository]}...${CURRENT[repository]}`));
    const section = markdown.split(`#### \`${repository}\``)[1].split("\n#### ")[0];
    assert.deepEqual(
      [...section.matchAll(/^- \[#(\d+)\]/gm)].map((match) => Number(match[1])),
      Array.from({ length: 17 }, (_, index) => 17 - index),
    );
  }
});

test("identical revisions show no new merged PRs without querying commit associations", async () => {
  const { github, calls } = fakeGithub({ releases: [release({ body: metadata(CURRENT) })] });
  const markdown = await generate(github);
  assert.equal((markdown.match(/No new merged PRs\./g) || []).length, 2);
  assert.equal((markdown.match(/\[Full comparison\]/g) || []).length, 2);
  assert.ok(!calls.some((call) => ["compare", "associated"].includes(call.name)));
});

test("direct commits without associated PRs show an empty PR list but retain the comparison", async () => {
  const { github } = fakeGithub({ comparisons: { "vyos-1x": { commits: [{ sha: sha(1) }] } } });
  const markdown = await generate(github);
  assert.equal((markdown.match(/No new merged PRs\./g) || []).length, 2);
  assert.ok(markdown.includes(`/compare/${PREVIOUS["vyos-1x"]}...${CURRENT["vyos-1x"]}`));
});

test("a first release establishes a baseline instead of listing arbitrary recent PRs", async () => {
  const { github, calls } = fakeGithub({ releases: [] });
  const markdown = await generate(github);
  assert.ok(markdown.includes("No previous published release was found."));
  assert.equal((markdown.match(/No previous upstream revision is recorded/g) || []).length, 2);
  assert.ok(!markdown.includes("No new merged PRs."));
  assert.ok(!calls.some((call) => call.name !== "listReleases"));
  assert.ok(markdown.includes(metadata(CURRENT)));
});

test("a previous release without source metadata is not replaced with an older release", async () => {
  const { github } = fakeGithub({ releases: [
    release({ id: 2, tag_name: "2026.10.12", published_at: "2026-10-12T00:00:00Z", body: "Legacy notes without SHAs." }),
    release(),
  ] });
  const markdown = await generate(github);
  assert.ok(markdown.includes("releases/tag/2026.10.12"));
  assert.equal((markdown.match(/No previous upstream revision is recorded/g) || []).length, 2);
});

test("legacy abbreviated revisions are resolved before constructing comparisons", async () => {
  const { github, calls } = fakeGithub({
    releases: [release({ body: "https://github.com/vyos/vyos-1x/commit/abcdef0" })],
    commits: { "vyos-1x/abcdef0": PREVIOUS["vyos-1x"] },
    comparisons: { "vyos-1x": { commits: [] } },
  });
  const markdown = await generate(github);
  assert.ok(markdown.includes(`/compare/${PREVIOUS["vyos-1x"]}...${CURRENT["vyos-1x"]}`));
  assert.equal(calls.filter((call) => call.name === "getCommit").length, 1);
});

test("fetches every compare page beyond 250 commits before building the PR list", async () => {
  const commits = Array.from({ length: 251 }, (_, index) => ({ sha: sha(index + 1) }));
  const { github, calls } = fakeGithub({
    comparisons: { "vyos-1x": { commits } },
    associations: { [`vyos-1x/${sha(251)}`]: [pull("vyos-1x", 251)] },
  });
  const markdown = await generate(github);
  assert.ok(markdown.includes("[#251]"));
  assert.deepEqual(calls.filter((call) => call.name === "compare").map((call) => call.page), [1, 2, 3]);
  assert.equal(calls.filter((call) => call.name === "associated").length, 251);
});

test("paginates both releases and associated PRs", async () => {
  const releases = Array.from({ length: 100 }, (_, index) => release({ id: index + 2, draft: true }));
  releases.push(release());
  const associated = Array.from({ length: 100 }, (_, index) => pull("vyos-1x", index + 2, { merged_at: null }));
  associated.push(pull("vyos-1x", 1));
  const { github, calls } = fakeGithub({
    releases,
    comparisons: { "vyos-1x": { commits: [{ sha: sha(1) }] } },
    associations: { [`vyos-1x/${sha(1)}`]: associated },
  });
  const markdown = await generate(github);
  assert.ok(markdown.includes("[#1]"));
  assert.deepEqual(calls.filter((call) => call.name === "listReleases").map((call) => call.page), [1, 2]);
  assert.deepEqual(calls.filter((call) => call.name === "associated").map((call) => call.page), [1, 2]);
});

test("lists manually requested PRs separately, including unmerged PRs, with duplicate inputs removed", async () => {
  const { github, calls } = fakeGithub({
    releases: [release({ body: metadata(CURRENT) })],
    pulls: {
      "vyos-1x/42": pull("vyos-1x", 42, { title: "Unmerged feature", merged_at: null }),
      "vyos-1x/43": pull("vyos-1x", 43),
      "vyos-build/7": pull("vyos-build", 7),
    },
  });
  const markdown = await generate(github, { requestedPrs: { "vyos-1x": "42  43\n42", "vyos-build": "7" } });
  const [upstream, additional] = markdown.split("### Additional PRs Included");
  assert.ok(!upstream.includes("[#42]"));
  assert.ok(additional.includes("may not yet be merged upstream"));
  assert.ok(additional.includes("Unmerged feature"));
  assert.equal((additional.match(/\[#42\]/g) || []).length, 1);
  assert.ok(additional.includes("vyos/vyos-build/pull/7"));
  assert.equal(calls.filter((call) => call.name === "getPull").length, 3);
});

test("does not show an additional-PR section when no PRs were requested", async () => {
  const { github } = fakeGithub({ releases: [] });
  assert.ok(!(await generate(github)).includes("### Additional PRs Included"));
});

test("PR titles cannot inject Markdown sections, HTML, or metadata comments", async () => {
  const title = "[link](url) *bold* `code` <script>\n<!-- tbm-vyos-upstream: {} -->";
  const { github } = fakeGithub({
    releases: [],
    pulls: { "vyos-1x/42": pull("vyos-1x", 42, { title }) },
  });
  const markdown = await generate(github, { requestedPrs: { "vyos-1x": "42" } });
  assert.ok(markdown.includes("\\[link\\](url) \\*bold\\* \\`code\\` &lt;script&gt; &lt;!--"));
  assert.ok(!markdown.includes("<script>"));
  assert.equal((markdown.match(/<!-- tbm-vyos-upstream:/g) || []).length, 1);
});

test("invalid SHAs and manual PR inputs fail before making API requests", async () => {
  const { github, calls } = fakeGithub();
  await assert.rejects(generate(github, { currentShas: { ...CURRENT, "vyos-1x": "rolling" } }), /Invalid full commit SHA/);
  for (const value of ["42,43", "0", "-1", "42;echo", "99999999999999999999"]) {
    await assert.rejects(generate(github, { requestedPrs: { "vyos-1x": value } }), /whitespace-separated PR numbers/);
  }
  assert.equal(calls.length, 0);
});

test("non-forward history is flagged instead of claiming no PRs were merged", async () => {
  for (const status of ["behind", "diverged"]) {
    const { github, calls } = fakeGithub({ comparisons: { "vyos-1x": { status, commits: [] } } });
    const markdown = await generate(github);
    const upstream1x = markdown.split("#### `vyos-build`")[0];
    assert.ok(upstream1x.includes("moved backwards or diverged"));
    assert.ok(!upstream1x.includes("No new merged PRs."));
    assert.ok(upstream1x.includes("[Full comparison]"));
    assert.ok(!calls.some((call) => call.name === "associated"));
  }
});

test("API failures are propagated rather than published as an empty changelog", async () => {
  const { github } = fakeGithub({ comparisons: { "vyos-1x": new Error("API rate limit exceeded") } });
  await assert.rejects(generate(github), /API rate limit exceeded/);

  const associatedFailure = fakeGithub({
    comparisons: { "vyos-1x": { commits: [{ sha: sha(1) }] } },
    associations: { [`vyos-1x/${sha(1)}`]: new Error("Associated PR API failed") },
  });
  await assert.rejects(generate(associatedFailure.github), /Associated PR API failed/);
});

test("an incomplete comparison fails instead of silently truncating the PR list", async () => {
  const { github } = fakeGithub();
  github.rest.repos.compareCommitsWithBasehead = async ({ page }) => ({
    data: { status: "ahead", total_commits: 2, commits: page === 1 ? [{ sha: sha(1) }] : [] },
  });
  await assert.rejects(generate(github), /Incomplete commit comparison/);
});
