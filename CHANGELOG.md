# Changelog

All notable changes to `jagc` are documented here.

## Format

- Keep `## [Unreleased]` at the top.
- Use release headers as `## [X.Y.Z] - YYYY-MM-DD`.
- Group entries under `### Added`, `### Changed`, `### Fixed` (optionally `### Removed` / `### Security`).
- Keep entries short and operator/user-facing.

## [Unreleased]

### Added

- Added end-to-end scheduled task support (one-off + recurring) with HTTP API (`/v1/threads/:thread_key/tasks`, `/v1/tasks*`), CLI command group (`jagc task create|list|get|update|delete|run|enable|disable`), SQLite migrations (`scheduled_tasks`, `scheduled_task_runs`), and in-process scheduler/recovery service.
- Added per-task execution threads for scheduled tasks, including Telegram lazy topic creation (`createForumTopic`) and persisted `execution_thread_key` routing.
- Added `defaults/skills/task-ops/SKILL.md` as the canonical low-turn scheduled-task operating guide for agents/operators.
- Added RRULE-based scheduled task recurrence support (`schedule.kind=rrule`) across API/CLI/store/scheduler, including migration `004_scheduled_tasks_rrule.sql` and timezone-aware next-run computation.
- Added Telegram `/delete` command to remove the current topic thread, clear jagc's topic-thread session mapping, and clear scheduled-task execution-thread bindings for that topic so future task runs can recreate a fresh topic.

### Changed

- Telegram thread routing is now topic-aware (`telegram:chat:<chat_id>:topic:<message_thread_id>` when available) across inbound message/callback mapping and runtime controls.
- Telegram general topic (`message_thread_id=1`) is now normalized to base-chat routing and outbound payloads omit `message_thread_id=1` to avoid Bot API `message thread not found` errors.
- Telegram run delivery now uses a reusable delivery path shared by normal inbound runs and scheduled task runs, with topic-aware `message_thread_id` payload propagation for send/edit/action/delete/document operations.
- Telegram scheduled tasks now always allocate a dedicated per-task topic on first due/run-now via `createForumTopic`, even when the task was created from a Telegram topic thread.
- Telegram task topic names now show only the task title (trimmed to Telegram limits) instead of `task:<id>` prefixes.
- Telegram topic-mode capability checks now document startup caching behavior (`has_topics_enabled` is read at adapter startup; BotFather toggles require jagc restart).
- Scheduled-task CLI ergonomics were simplified: `jagc task list` now uses `--state <all|enabled|disabled>` with default `all`; `jagc task run` no longer requires `--now` and now supports `--wait` + polling controls for terminal status in one command.
- `jagc task create|update` now supports `--rrule <rule>` for calendar-style recurrences (for example first Monday monthly, biweekly Monday).
- Runtime harness context task guidance is now intentionally terse and points to the dedicated `task-ops` skill for operational workflows.
- Runtime harness context task guidance now distinguishes approval flow: direct user task/scheduling requests execute via `skills/task-ops/SKILL.md` without extra confirmation, while agent-suggested automation requires explicit user approval before creating/updating tasks.
- `defaults/skills/task-ops/SKILL.md` description now explicitly states when to use the skill (user-asked scheduling/task management and agent-proposed automation with approval) and what it covers (command contract, JSON-first workflow, scheduling/time conversion, verification policy).
- `pnpm dev` now prepends a repo-local `jagc` shim to `PATH`, so in-process agent `bash` calls resolve `jagc` to `pnpm dev:cli` from the current checkout instead of a globally installed CLI.
- Pi runtime bash tool executions are now thread-aware by default: each command receives `JAGC_THREAD_KEY` and `JAGC_TRANSPORT`, plus Telegram route vars (`JAGC_TELEGRAM_CHAT_ID`, `JAGC_TELEGRAM_TOPIC_ID`) for Telegram thread keys.
- `jagc task create` now defaults creator thread to `$JAGC_THREAD_KEY` when present (falling back to `cli:default`), so agent-created tasks in Telegram inherit the active chat/topic thread without requiring explicit `--thread-key`.
- Task-ops skill examples now avoid hardcoded `cli:*` thread keys and default to current-thread task creation unless cross-thread targeting is explicitly requested.
- Scheduled-task lifecycle logging is now more explicit: task creation logs include creator thread + delivery target, execution-thread allocation logs include Telegram topic creation request/result, and delivery logs include skip reasons (for example non-Telegram provider) plus Telegram chat/topic routing metadata.

### Fixed

- Scheduled task occurrence bookkeeping now survives restarts by resuming pending task-runs and reconciling dispatched task-runs against terminal run state.
- Cron next-run computation now handles midnight (`0 0 ...`) correctly across timezones.
- Once-schedule timestamps now accept UTC ISO-8601 variants (for example `...Z` or `...+00:00`) and normalize to canonical UTC storage.
- `jagc task ... --json` failures now emit structured JSON error envelopes instead of plain stderr text.
- Thread-scoped runtime env injection now reaches bash tool executions reliably (`JAGC_THREAD_KEY`, `JAGC_TRANSPORT`, and Telegram route vars), by overriding the built-in `bash` tool through `customTools` instead of relying on `createAgentSession({ tools })` options.
- Telegram topic creation now surfaces explicit `telegram_topics_unavailable` guidance when bot private topics are disabled (`has_topics_enabled=false`) or the Bot API reports unresolved topic mode (`chat is not a forum` / `message thread not found`).
- Task title updates no longer rename creator-origin topics for legacy tasks whose execution thread matches the creator topic; topic-title sync now applies only to task-owned Telegram topics.

## [0.3.7] - 2026-02-13

### Added

- None.

### Changed

- Updated runtime dependencies to latest compatible releases, including `@mariozechner/pi-coding-agent` (`^0.52.12`), `better-sqlite3` (`^12.6.2`), `grammy` (`^1.40.0`), and `pino` (`^10.3.1`).
- Updated development tooling versions, including `@biomejs/biome` (`^2.3.15`) and `@types/node` (`^25.2.3`).

### Fixed

- None.

## [0.3.6] - 2026-02-13

### Added

- None.

### Changed

- Clarified agent prompt-context guidance to explicitly state AGENTS.md files are auto-loaded by scope and should not be searched proactively.

### Fixed

- None.

## [0.3.5] - 2026-02-13

### Added

- Added Telegram Markdown rendering pipeline that converts assistant Markdown into Bot API `entities` and supports language-aware code attachments for oversized fenced code blocks (for example `snippet-1.ts`).

### Changed

- Telegram terminal run replies now always use entity-based rich-text rendering instead of plain-text passthrough.
- Telegram progress updates now send/edit via Bot API `entities` payloads for thinking-snippet formatting while keeping tool-call labels and control-path text literal.

### Fixed

- Telegram no longer depends on fragile MarkdownV2 string escaping for assistant replies.
- Telegram entity rendering now strips/segments incompatible overlaps (for example `code` inside links, or formatting wrappers around inline code) to avoid Bot API entity parse failures.
- Telegram progress edit recovery now recreates the message with the same entity payload after `message to edit not found`, so thinking formatting is preserved.
- Telegram control-path replies (for example the unauthorized-user allow command prompt) are sent as literal text so markdown-like paths/commands are not mutated.

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
