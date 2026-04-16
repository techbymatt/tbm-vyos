# TBM VyOS Agent Instructions

This file contains high-signal context for AI agents working in this repository.

## Architecture & Code Boundaries

- **Not a standard source repo**: This repository is an independent builder for a custom VyOS fork (TBM VyOS). It does not contain the raw VyOS source code.
- **Upstream Sources**: The GitHub Actions CI (`.github/workflows/build.yaml`) dynamically checks out the `vyos/vyos-build` and `vyos/vyos-1x` repositories during the build process.
- **Patching System**: Modifications to upstream VyOS behavior are handled exclusively via patch files:
  - `patch/vyos-build.patch` (applied to `vyos-build`)
  - `patch/vyos-1x.patch` (applied to `vyos-1x`)
- **Editing Rule**: Do NOT try to directly edit upstream VyOS Python or shell source files. To modify upstream behavior, you must update the `.patch` files instead.

## Build Process & Commands

The builds are containerized using Docker Compose.

- **Build Configuration**: Uses `amd64.yaml` and `arm64.yaml` to define the Docker build environments.
- **CI Build Flow**: The official flow in `.github/workflows/build.yaml` does the following sequentially:
  1. Clones `vyos/vyos-build` and `vyos/vyos-1x`.
  2. Applies the `patch/*.patch` files.
  3. Builds `vyos-1x` via `make deb` inside a container.
  4. Copies the resulting `.deb` files into `vyos-build/packages`.
  5. Builds the final ISO using `sudo ./build-vyos-image` inside the container.
- **Local Reproduction**: To test builds or generate patches locally, you must manually replicate the CI checkout and patching steps, then run the build steps using `docker compose --file amd64.yaml run --rm build ...` (refer to the `build.yaml` workflow for exact commands).

## Testing Quirks

- **Smoketests**: Extensive smoketests are run in CI (`.github/workflows/smoketest.yaml`) against the built ISO using QEMU.
- **Test Categories**: Tests are split into categories: `cli`, `cli-interfaces`, `cli-vpp`, `config`, `raid`, `secureboot`, and `tpm`.
- If a smoketest fails, inspect the patched upstream testing code (e.g., `scripts/check-qemu-install` modified via `vyos-build.patch`).

## Operational Gotchas

- **Secure Boot & Keys**: The CI generates and injects custom Secure Boot certificates and a Minisign public key (`tbm.minisign.pub`) into the build. Do not modify these cryptographic injection steps unless explicitly instructed.
- **Branding & Support**: TBM VyOS patches change the default system branding and support strings. Do not revert branding patches that replace `VyOS` with `TBM VyOS` or update the support URL/email to `support@tech.bymatt.au`.
