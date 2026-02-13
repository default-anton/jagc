# Changelog

All notable changes to `jagc` are documented here.

## Format

- Keep `## [Unreleased]` at the top.
- Use release headers as `## [X.Y.Z] - YYYY-MM-DD`.
- Group entries under `### Added`, `### Changed`, `### Fixed` (optionally `### Removed` / `### Security`).
- Keep entries short and operator/user-facing.

## [Unreleased]

### Added

- Added Telegram Markdown rendering pipeline that converts assistant Markdown into Bot API `entities` and supports language-aware code attachments for oversized fenced code blocks (for example `snippet-1.ts`).

### Changed

- Telegram terminal run replies now always use entity-based rich-text rendering instead of plain-text passthrough.

### Fixed

- Telegram no longer depends on fragile MarkdownV2 string escaping for assistant replies.
- Telegram entity rendering now strips/segments incompatible overlaps (for example `code` inside links, or formatting wrappers around inline code) to avoid Bot API entity parse failures.

## [0.3.4] - 2026-02-12

### Added

- None.

### Changed

- Updated bundled `@mariozechner/pi-coding-agent` dependency from `^0.52.7` to `^0.52.10` (latest).

### Fixed

- None.

## [0.3.3] - 2026-02-12

### Added

- Added Telegram access control allowlist via `JAGC_TELEGRAM_ALLOWED_USER_IDS` (deny-by-default when empty), in-chat first-contact authorization guidance, canonicalized numeric user-id handling, and new CLI controls `jagc telegram allow --user-id <id>` / `jagc telegram list` for operator-managed authorization.

### Changed

- Release workflow and runbook now publish to npm with provenance metadata (`npm publish --provenance --access public`) for public-source trusted publishing.
- `.env.example` now uses `$HOME/.jagc` defaults instead of personal absolute paths.

### Fixed

- `.gitignore` now includes `.envrc` to reduce accidental local secret commits.
- Telegram thinking preview now keeps separate reasoning blocks on separate `~` lines (instead of merging adjacent markdown sections like `**...****...**` into one line) when the model streams multiple thinking content parts.
- Telegram adapter no longer rejects unknown slash commands with `Unknown command: /...`; unknown slash messages (for example `/handoff`) now flow to the assistant unchanged as normal `followUp` input.
- Thread session persistence now reconciles after every run, so extension-driven `ctx.newSession(...)` switches (for example `/handoff`) update `thread_sessions` and survive service restarts.

## [0.3.2] - 2026-02-11

### Added

- None.

### Changed

- Tightened runtime harness prompt guidance for jagc self-ops: agents now start with `jagc --help`, use `jagc` as the first control surface for jagc-runtime tasks, and prefer `--json` output when available.
- Added missing descriptions across CLI command groups so `jagc --help` and nested help screens consistently explain each command/subcommand.

### Fixed

- None.

## [0.3.1] - 2026-02-11

### Added

- Added top-level CLI version flags: `jagc -v` and `jagc --version`.

### Changed

- Removed the deferred roadmap doc and cleaned up all in-repo/package references.

### Fixed

- `jagc install` now stores Telegram bot tokens in `<workspace>/service.env` (`JAGC_TELEGRAM_BOT_TOKEN`) instead of embedding them in the launchd plist, so rerunning `jagc install` without `--telegram-bot-token` preserves an existing token already present in `service.env`.

## [0.3.0] - 2026-02-11

### Added

- Added thread-run cancellation controls without session reset across all primary surfaces: API `POST /v1/threads/:thread_key/cancel`, CLI `jagc cancel`, and Telegram `/cancel`.
- Added first-class workspace package management commands: `jagc packages install|remove|update|list|config` (with `jagc package` alias), wrapping jagc's bundled pi dependency so operators can manage workspace package sources without relying on a globally installed `pi` binary.

### Changed

- Runtime/harness context prompt injection now includes workspace paths for skills/extensions (`~/.jagc/skills`, `~/.jagc/extensions` by default), and the global AGENTS loader no longer emits those path lines.
- Telegram run handling no longer sends timeout handoff text (`"Still running. I'll send the result when it's done."`); runs stay on live progress until terminal completion.
- Telegram progress tool-call lines now update in place on completion and append status/duration suffixes like `[✓] done (0.4s)` and `[✗] failed (0.4s)`, instead of printing the same command twice.
- Telegram progress rendering now preserves long-run visibility by flushing overflowed progress lines into additional `progress log (continued):` messages instead of silently trimming older lines.

### Fixed

- macOS launchd services now re-apply `service.env.snapshot` + `service.env` at server startup with override semantics, so launchd's default `PATH` no longer hides `gh` and other user-installed CLIs.
- Thread cancellation now reports `cancelled: false` when a thread session exists but has no active/queued work, so Telegram `/cancel` no longer claims success on idle chats.
- Telegram progress archive flushing now consumes archive lines per successful chunk send and retries failed sends without duplicating or dropping overflowed progress lines.
- Removed unused Telegram polling `waitTimeoutMs` config from adapter/test surfaces.
- Telegram `/cancel` now aborts in-flight per-chat waiters so successful cancellations no longer emit a second terminal `❌ run ... failed: This operation was aborted` reply.

## [0.2.0] - 2026-02-10

### Added

- Added end-to-end thread session sharing via secret GitHub gists: API `POST /v1/threads/:thread_key/share`, CLI `jagc share`, and Telegram `/share`.
- Added CLI command `jagc defaults sync` to update bundled workspace defaults (`skills/**`, `extensions/**`) in place without deleting user-created files.

### Changed

- pi runtime session setup now disables SDK built-in AGENTS.md/skills auto-loading and relies on bundled default extensions to inject global AGENTS context, available skills metadata, local pi docs/examples references, and Codex `apply_patch` harness instructions into the system prompt.
- Runtime/harness context (jagc wraps pi; pi-native extension/package capabilities; jagc CLI self-ops hints) now comes from a bundled default extension, so it remains present even when users fully customize `SYSTEM.md`.
- Bundled default extension filenames now use numeric prefixes to enforce deterministic load order: `10-codex-harness.ts`, `20-runtime-harness-context.ts`, `30-global-agents-loader.ts`, `40-skills-loader.ts`.
- `pnpm dev` now uses `JAGC_DEV_OVERWRITE_DEFAULTS=1` to overwrite workspace `SYSTEM.md`, `AGENTS.md`, and bundled `skills/**`/`extensions/**` defaults while preserving existing `settings.json`.

### Fixed

- Packaged runtime now resolves bundled default template paths correctly when running from npm installs, restoring package smoke server startup.
- Telegram polling now deletes the startup placeholder progress message when a run finishes without any thinking snippets or tool activity, so chats no longer keep stale lines like `mapmaking...` after simple replies.

## [0.1.9] - 2026-02-09

### Added

- macOS service install now creates workspace env files: `service.env.snapshot` (managed shell snapshot) and `service.env` (user overrides), and `jagc status`/`jagc restart` now print both paths.

### Changed

- launchd service startup now loads `service.env.snapshot` then `service.env` via Node `--env-file-if-exists`, so user overrides apply on restart without hand-editing plist files.
- Node engine requirement is now `>=20.19.0 <21 || >=22.9.0`, and `jagc doctor` enforces the same runtime gate for launchd env-file support.
- `jagc doctor` now checks for both service env files.
- Workspace bootstrap `.gitignore` defaults now include `service.env` and `service.env.snapshot`.
- Default workspace `SYSTEM.md` now explicitly states the jagc + pi harness context and points the agent to use `jagc` service commands for self-ops.

### Fixed

- `jagc install` no longer risks hanging indefinitely while capturing login-shell environment; shell env capture now times out and falls back safely.
- Workspace bootstrap now initializes `JAGC_WORKSPACE_DIR` as a local git repository (`git init`) when missing, so `jagc install` no longer leaves a non-repo `~/.jagc`.

## [0.1.8] - 2026-02-09

### Added

- None.

### Changed

- Release workflow now publishes with `NPM_CONFIG_PROVENANCE=false npm publish --access public` because npm does not support provenance for private GitHub source repositories.

### Fixed

- None.

## [0.1.7] - 2026-02-09

### Added

- None.

### Changed

- Release workflow now runs on Node 24 and upgrades npm to `>=11.5.1` so npm trusted publishing (OIDC) can authenticate correctly.

### Fixed

- None.

## [0.1.6] - 2026-02-09

### Added

- None.

### Changed

- Release workflow trusted-publish step now strips npmrc token lines and unsets `NODE_AUTH_TOKEN` before `npm publish`, while failing only if `NPM_TOKEN` is explicitly configured.

### Fixed

- None.

## [0.1.5] - 2026-02-09

### Added

- None.

### Changed

- Release workflow trusted-publish path now unsets token env only within the publish step (instead of exporting empty token env globally), while still failing fast if token auth is configured.

### Fixed

- None.

## [0.1.4] - 2026-02-09

### Added

- None.

### Changed

- Release workflow now enforces npm trusted publishing by stripping token-based npm auth (`NODE_AUTH_TOKEN` / `NPM_TOKEN`) and verifying token auth is absent before `npm publish --provenance`.
- Telegram progress updates no longer show status headers like `queued`, `working`, or `done`; they now start with a short single-word placeholder and drop it as soon as the first thinking/tool snippet arrives.
- Expanded Telegram startup placeholder variety with a larger set of creative single-word lines while preserving the same lowercase `word...` format.

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
