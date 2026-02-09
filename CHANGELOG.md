# Changelog

All notable changes to `jagc` are documented here.

## Format

- Keep `## [Unreleased]` at the top.
- Use release headers as `## [X.Y.Z] - YYYY-MM-DD`.
- Group entries under `### Added`, `### Changed`, `### Fixed` (optionally `### Removed` / `### Security`).
- Keep entries short and operator/user-facing.

## [Unreleased]

### Added

- None.

### Changed

- None.

### Fixed

- None.

## [0.1.3] - 2026-02-09

### Added

- None.

### Changed

- None.

### Fixed

- `scripts/pack-smoke.sh` now checks tarball contents from a captured file instead of a `tar | grep` pipe, avoiding `pipefail` false negatives in CI.

## [0.1.2] - 2026-02-09

### Added

- None.

### Changed

- None.

### Fixed

- `scripts/pack-smoke.sh` now falls back to `grep` when `rg` is unavailable, so `pnpm release:gate` works on stock GitHub Actions runners.

## [0.1.1] - 2026-02-09

### Added

- None.

### Changed

- `pnpm test:pack` now asserts packaged defaults include `defaults/skills/**` and verifies workspace bootstrap creates `skills/*` from bundled defaults.

### Fixed

- Telegram progress updates now flush the latest buffered thinking snippet before tool/text lifecycle events, preventing stale mid-token previews like `~ **Listing` when newer thinking deltas already arrived.
- npm package contents now include `defaults/skills/**` (and `defaults/extensions/**`), restoring default skill bootstrap for fresh installs.

## [0.1.0] - 2026-02-09

### Added

- npm-distributable CLI package (`jagc`) with built artifacts and curated package contents.
- First supported macOS deployment path via top-level CLI service commands:
  - `jagc install`
  - `jagc status`
  - `jagc restart`
  - `jagc uninstall`
  - `jagc doctor`
- Launchd-managed per-user service installation with workspace-scoped logs and safety defaults.
- Package smoke loop (`pnpm test:pack`) validating tarball install + runnable server + CLI roundtrip.
- CI release gate workflow (`pnpm release:gate`) on GitHub Actions.

### Changed

- Deployment docs now treat macOS npm+launchd as the primary supported install path.
- Local release gate consolidated into a single canonical command.
- Project license changed from UNLICENSED to MIT (`LICENSE` added).

### Fixed

- Service status/restart/doctor health targeting now resolves host/port from installed service config.
- Service command failures now return clean one-line CLI errors (no stack dumps).
- Service manager no longer selects TypeScript server entrypoints for launchd runtime.
