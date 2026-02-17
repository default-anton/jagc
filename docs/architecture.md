# jagc architecture (current implementation)

This doc is the implementation snapshot (not design intent).

- Current operator-facing contract: [`README.md`](../README.md)

## Implemented surface (v1)

### HTTP API

- Core run lifecycle: `GET /healthz`, `POST /v1/messages`, `GET /v1/runs/:run_id`
- Scheduled tasks: `POST /v1/threads/:thread_key/tasks`, `GET /v1/tasks`, `GET /v1/tasks/:task_id`, `PATCH /v1/tasks/:task_id`, `DELETE /v1/tasks/:task_id`, `POST /v1/tasks/:task_id/run-now`
- OAuth broker: `GET /v1/auth/providers`, `POST /v1/auth/providers/:provider/login`, `GET /v1/auth/logins/:attempt_id`, `POST /v1/auth/logins/:attempt_id/input`, `POST /v1/auth/logins/:attempt_id/cancel`
- Runtime controls: `GET /v1/models`, `GET /v1/threads/:thread_key/runtime`, `PUT /v1/threads/:thread_key/model`, `PUT /v1/threads/:thread_key/thinking`, `POST /v1/threads/:thread_key/cancel`, `DELETE /v1/threads/:thread_key/session`, `POST /v1/threads/:thread_key/share`

### CLI

- `jagc -v`, `jagc --version`
- `jagc health`
- `jagc message`
- `jagc run wait`
- `jagc auth providers`, `jagc auth login <provider>`
- `jagc task create|list|get|update|delete|run [--wait]|enable|disable` (`task list --state <all|enabled|disabled>`, `task create|update --rrule <rule>`); `task create` defaults creator thread to `$JAGC_THREAD_KEY` when set, else `cli:default`
- `jagc cancel`, `jagc new`, `jagc share`, `jagc defaults sync`, `jagc packages install|remove|update|list|config`, `jagc telegram allow|list`, `jagc model list|get|set`, `jagc thinking get|set`
- Service lifecycle + diagnostics: `jagc install|status|restart|uninstall|doctor` (macOS launchd implementation, future Linux/Windows planned)

### Runtime/adapters

- Executors: `echo` (deterministic), `pi` (real agent)
- `PiRunExecutor` creates pi sessions with a custom `DefaultResourceLoader` that disables SDK built-in AGENTS.md/skills loading; equivalent context is injected by bundled workspace extensions in `defaults/extensions/*.ts` (runtime/harness context, global AGENTS hierarchy, available skills metadata, local pi docs/examples paths, and Codex harness notes)
- Telegram polling adapter (personal chats) with `/settings`, `/cancel`, `/new`, `/delete`, `/share`, `/model`, `/thinking`, `/auth` and pass-through for unknown slash commands (for prompt-template packages like `/handoff`)
- SQLite persistence (`runs`, ingest idempotency + payload hash, `thread_sessions`, temporary `input_images`)
- SQLite DB is configured in WAL mode with `foreign_keys=ON`, `synchronous=NORMAL`, and `busy_timeout=5000`
- Structured Pino JSON logging with component-scoped child loggers shared across server/runtime/adapters
- HTTP request completion/error events are emitted from Fastify hooks with request IDs and duration fields
- In-process run scheduler for dispatch/recovery (no external workflow engine)
- CI release gate runs in GitHub Actions via `pnpm release:gate` (typecheck + lint + test + build + package smoke)

## Workspace bootstrap

- Startup bootstraps `JAGC_WORKSPACE_DIR` (`~/.jagc` by default) with directory mode `0700`.
- Bootstrap creates default `SYSTEM.md`, `AGENTS.md`, and `settings.json` from repo templates when missing (does not overwrite by default).
- Bootstrap also seeds bundled `defaults/skills/**` and `defaults/extensions/**` files into the workspace when missing (does not overwrite by default), including context-injection extensions for runtime/harness context, global AGENTS.md, skills listing, local pi docs/examples references, and Codex harness instructions.
- Dev-only overwrite mode (`JAGC_DEV_OVERWRITE_DEFAULTS=1`, enabled by `pnpm dev`) rewrites workspace `SYSTEM.md`, `AGENTS.md`, bundled `defaults/skills/**`, and bundled `defaults/extensions/**` on each startup, while preserving existing `settings.json`.
- `pnpm dev` also prepends a repo-local `scripts/dev-bin/jagc` shim to `PATH`, so agent `bash` calls to `jagc` resolve to `pnpm dev:cli` from the current checkout instead of any globally installed `jagc` binary.
- Default `settings.json` includes bootstrap pi packages (`pi-librarian`, `pi-subdir-context`) but remains user-editable after creation.
- `jagc packages ...` is a thin wrapper around the bundled `@mariozechner/pi-coding-agent` package manager CLI (`dist/cli.js`), executed with `PI_CODING_AGENT_DIR=<workspace>` and `cwd=<workspace>` so package operations target the jagc workspace and do not depend on a globally installed `pi` binary.
- Bootstrap initializes `JAGC_WORKSPACE_DIR` as a local git repository (`git init`) when `.git` is missing.
- Bootstrap also ensures workspace `.gitignore` has `.sessions/`, `auth.json`, `git/`, `service.env`, `service.env.snapshot`, `jagc.sqlite`, `jagc.sqlite-shm`, and `jagc.sqlite-wal` entries.

## macOS service lifecycle (CLI-managed)

- `jagc install` writes a per-user launch agent at `~/Library/LaunchAgents/<label>.plist` (`com.jagc.server` by default), then `launchctl bootstrap` + `kickstart` starts the service.
- launchd runs `node --env-file-if-exists=<workspace>/service.env.snapshot --env-file-if-exists=<workspace>/service.env <installed package>/dist/server/main.mjs`.
- Server startup re-applies those same env files in-order with explicit override semantics so launchd defaults (notably `PATH`) do not mask workspace env entries.
- Node runtime requirement for this launch path is `>=20.19.0 <21` or `>=22.9.0`.
- `jagc install` always regenerates `<workspace>/service.env.snapshot` from the user's login shell (PATH/tooling env) and creates `<workspace>/service.env` when missing.
- `service.env` is never wholesale-overwritten by `jagc install` once it exists; user edits are picked up after `jagc restart`.
- `jagc install --telegram-bot-token ...` upserts `JAGC_TELEGRAM_BOT_TOKEN` into `<workspace>/service.env`; rerunning install without that flag preserves any existing token in `service.env`.
- launchd plist environment variables include `JAGC_WORKSPACE_DIR`, `JAGC_DATABASE_PATH`, `JAGC_HOST`, `JAGC_PORT`, `JAGC_RUNNER`, and `JAGC_LOG_LEVEL` (Telegram token comes from env files).
- Logs default to `$JAGC_WORKSPACE_DIR/logs/server.out.log` and `server.err.log`.
- `jagc status` inspects launchd (`launchctl print`) and API health (`/healthz`).
- `jagc restart` issues `launchctl kickstart -k` and waits for `/healthz`.
- `jagc uninstall` removes the launch agent and unloads it; `--purge-data` additionally deletes the workspace directory.

## Request/execution flow

### 1) Message ingest (`POST /v1/messages`)

- `src/server/app.ts` validates payload.
- Header/body idempotency key mismatch returns `400`.
- Optional `images[]` payload (`mime_type`, `data_base64`, optional `filename`) is validated with stable error codes:
  - `image_count_exceeded` (max 10)
  - `image_total_bytes_exceeded` (max 50MiB decoded)
  - `image_mime_type_unsupported` (`image/jpeg|image/png|image/webp|image/gif`)
  - `image_base64_invalid`
- Fastify body limit is set to 75MiB for `/v1/messages`; decoded-size validation remains authoritative at 50MiB.
- `RunService.ingestMessage(...)` writes/gets run via `RunStore.createRun(...)`.
- Ingest-triggered cleanup purges expired `input_images` rows (pending or run-bound, 3-day TTL) without cron/background workers.
- Same `idempotency_key` with mismatched canonical payload (`thread_key`, `text`, `delivery_mode`, images) returns `409 idempotency_payload_mismatch`.
- Non-deduplicated runs are enqueued into the in-process run scheduler.
- Response is a normalized run envelope (`run_id`, `status`, `output`, `error`) with `202`.

### 2) Run dispatch and execution

- `LocalRunScheduler` dispatches runs in process.
- Scheduler deduplicates currently scheduled run IDs (`run_id`) and does not use an external queue/workflow engine.
- Scheduler serializes dispatch per `thread_key` (FIFO at dispatch boundary), while allowing different threads to dispatch concurrently.
- Scheduler calls `RunService.dispatchRunById(run_id)`, which starts background execution only if the run is still `running` and not already in-flight.
- `RunExecutor.execute(run)` returns structured `RunOutput` or throws.
- `RunService` emits run progress lifecycle events (`queued`, `started`, `succeeded`, `failed`) and forwards executor/session progress events when provided (for adapters/UIs).
- Service finalizes with `markSucceeded` / `markFailed`.

### 3) Run polling (`GET /v1/runs/:run_id`)

- Returns normalized run response.
- Failed runs include `error.message`.

## Durability + recovery

- Source of truth is SQLite run state (`runs.status`).
- `RunService.init()` performs:
  - immediate scan of `runs.status='running'`
  - periodic recovery pass (15s) to re-enqueue missing in-process work
- Recovery skips runs already in the local in-flight completion set.
- Scheduler deduplicates currently scheduled run IDs so ingest + recovery can race safely.

### Concurrency scope

- Run dispatch is in-process and single-server-process scoped.
- Same-thread turn ordering (`followUp` / `steer`) is enforced by per-thread `ThreadRunController` instances in the pi executor.
- Multi-process/global run coordination is intentionally deferred post-v0.

## Scheduled task domain + scheduler

- Storage tables: `scheduled_tasks`, `scheduled_task_runs` (`migrations/003_scheduled_tasks.sql`).
- `ScheduledTaskService` runs in-process (`src/server/scheduled-task-service.ts`) with a 5s poll loop by default:
  - claims due tasks (`enabled=1 AND next_run_at <= now`)
  - creates/ensures task occurrence rows (`scheduled_task_runs`) with deterministic idempotency keys
  - lazily ensures per-task execution thread (`execution_thread_key`) on first due/run-now
  - advances schedule (`once` disables; `cron`/`rrule` compute first future slot strictly `> now`)
  - dispatches pending occurrences via `RunService.ingestMessage(...)` (`source=task:<task_id>`, `deliveryMode=followUp`)
- Completion bookkeeping is durable and restart-safe:
  - pending task-runs are resumed on startup/ticks
  - dispatched task-runs are reconciled against run terminal state and update `scheduled_tasks.last_run_*`
- `run-now` creates a task occurrence row for current UTC timestamp and dispatches immediately without shifting recurring schedule anchors.

## Session/thread model (pi executor)

- Session identity is per `thread_key`.
- `PiRunExecutor` configures bash tool spawn hooks per thread and injects thread-scoped env (`JAGC_THREAD_KEY`, `JAGC_TRANSPORT`, plus Telegram `JAGC_TELEGRAM_CHAT_ID` / `JAGC_TELEGRAM_TOPIC_ID`) on every command execution.
- `thread_sessions` persists `thread_key`, `session_id`, `session_file`.
- `PiRunExecutor` reopens persisted sessions when possible; creates/persists when missing/invalid.
- After each run, `PiRunExecutor` reconciles `thread_sessions` with the live `AgentSession` (`session_id`/`session_file`) so extension-driven session switches during a run remain durable across restarts.
- In-memory session cache is hot-path only; SQLite mapping is source of truth across restarts.

### Same-thread coordination (non-obvious)

`ThreadRunController` coordinates same-thread turns against a single pi session:

- First active run uses `session.prompt(...)`, including optional run-linked images.
- Additional same-thread runs queue via `session.followUp(...)` or `session.steer(...)`, including optional run-linked images.
- Run-linked images are loaded from `input_images` immediately before submission, and deleted immediately after the corresponding submission call returns successfully (`prompt`/`followUp`/`steer`).
- Run completion attribution comes from session events (not prompt promise timing), using user/assistant boundary events.

Operational note:

- With the in-process scheduler feeding a per-thread controller, same-thread `followUp`/`steer` messages can be delivered while a session is active.
- If the process crashes, pending `running` rows are replayed from SQLite on recovery.

## Telegram polling behavior

- Ingest source: grammY long polling (personal chats).
- Thread mapping: `thread_key = telegram:chat:<chat_id>` for base chats, and `thread_key = telegram:chat:<chat_id>:topic:<message_thread_id>` when Telegram topic/thread context is present on inbound message/callback payloads; Telegram general topic (`message_thread_id=1`) is normalized to base-chat routing (no `:topic:1` key).
- User mapping: `user_key = telegram:user:<from.id>`.
- Access gate: Telegram message/callback handling is allowlisted by `JAGC_TELEGRAM_ALLOWED_USER_IDS` (`from.id` values). Empty allowlist means deny all. Unauthorized users receive an in-chat command prompt (`jagc telegram allow --user-id <id>`) and no run is ingested.
- Default delivery mode for normal text messages: `followUp` (`/steer` is explicit).
- Telegram `/cancel`, API `POST /v1/threads/:thread_key/cancel`, and CLI `jagc cancel` abort active work for the thread without resetting session context.
- After a successful Telegram `/cancel`, the adapter suppresses the in-chat terminal `❌ run ... failed: This operation was aborted` reply for that cancelled run (the explicit cancel confirmation message is the terminal user-facing signal).
- Telegram `/new` and API `DELETE /v1/threads/:thread_key/session` abort/dispose the current thread session, clear persisted `thread_sessions` mapping, and cause the next message to create a fresh pi session.
- Telegram `/delete` deletes the current Telegram topic thread (only when invoked from a topic), aborts topic-scoped background delivery waiters, clears matching scheduled-task execution-thread bindings for that topic (so future runs recreate topics), and resets the corresponding topic-thread session mapping when thread controls are available.
- Telegram `/share` and API `POST /v1/threads/:thread_key/share` export the current thread session to HTML and upload it as a secret GitHub gist; response includes both gist URL and share-viewer URL.
- Adapter starts a per-run progress reporter (in-chat append-style progress message + typing indicator) as soon as a run is ingested.
- On assistant-bound inbound text (`followUp`/`steer`), the adapter also sends a best-effort random emoji reaction on the user message (from a curated working set) so users get immediate "working on it" feedback even before progress text appears.
- Progress is driven by run-level events emitted from `RunService` and pi session events forwarded by `ThreadRunController` (`assistant_text_delta`, `assistant_thinking_delta`, `tool_execution_*`, turn/agent lifecycle), rendered as compact append-log lines (`>` for tool calls with args-focused snippets, `~` for short thinking snippets); when thinking streams multiple content parts, each part gets its own `~` line to avoid merged markdown fragments; tool call completion edits the original `>` line in place to append status + duration (`[✓] done (0.4s)` / `[✗] failed (0.4s)`). Progress send/edit calls use Telegram `entities` payloads for thinking-line markdown styling, while tool-call labels stay literal to preserve exact path/command text.
- Until the first visible thinking/tool snippet arrives, the progress message shows a short single-word placeholder (for immediate feedback); once the first snippet arrives, that placeholder is removed, and if the run finishes without any snippets, the placeholder message is deleted.
- Status updates are edit-throttled and retry-aware for Telegram rate limits (`retry_after`); when progress overflows the editable message limit, older progress lines are flushed into additional `progress log (continued):` messages and the live message keeps tail updates.
- Adapter keeps waiting for terminal run status in the background and replies with output/error when done (no timeout handoff message).
- Scheduled task runs reuse the same run-delivery path and are delivered into Telegram topics; first run always lazily creates a dedicated per-task topic via `createForumTopic` using the task title only (trimmed to Telegram topic-title limits), then persists the resulting `message_thread_id` route metadata (including tasks created from base/default Telegram chat routing and creator topic threads).
- Topic-thread delivery sends/edits/actions/documents/progress payloads with `message_thread_id` so all progress/final output stays inside the task topic.
- Task title sync (`editForumTopic`) applies only to task-owned topics; creator-origin topics are intentionally left unchanged.
- Topic creation checks Telegram bot capability (`getMe().has_topics_enabled`) and returns actionable `telegram_topics_unavailable` errors when private-topic mode is disabled or unresolved by Telegram API.
- Terminal assistant text replies are parsed as Markdown and sent via Telegram `entities` (not `parse_mode` Markdown strings) for robust formatting.
- Other adapter-originated text replies (command/status errors, runtime-control panels, and auth/allowlist guidance) are sent as literal text to avoid markdown-driven mutation of operator commands and path snippets.
- Fenced code blocks above inline thresholds are emitted as Telegram document uploads with language-aware filenames (for example `snippet-1.ts`); shorter blocks stay inline as `pre` entities.
- `/model` and `/thinking` use button pickers; text args are intentionally unsupported.
- Unknown slash commands are not rejected by the adapter; they are forwarded to the assistant as normal `followUp` text with the original message content.
- After model/thinking changes, the adapter returns to the `/settings` panel and shows the updated runtime state.
- The `/settings` panel does not include a dedicated refresh button; reopening `/settings` (or returning from a change) re-fetches live state.
- Outdated/invalid callback payloads trigger stale-menu recovery: the adapter re-renders the latest `/settings` panel.
- Telegram callback payload size is capped at 64 bytes; over-limit model/auth options are hidden and surfaced with an in-chat warning.

## OAuth broker + runtime controls

### OAuth broker

- Backed by `PiAuthService` + `OAuthLoginBroker`.
- Login attempts are owner-scoped via `X-JAGC-Auth-Owner`.
- Follow-up endpoints require owner header and return `404` on owner mismatch.
- Capacity behavior: if active attempts fill broker capacity, new starts return `429 auth_login_capacity_exceeded` (no eviction of active attempts).
- Successful credentials persist via pi `AuthStorage` to workspace `auth.json`.

### Runtime controls (model/thinking/cancel/share)

- `PiRunExecutor` is source of truth for per-thread runtime state.
- Model updates call `AgentSession.setModel(...)` (validated via pi `ModelRegistry`, persisted via `SettingsManager`).
- Thinking updates call `AgentSession.setThinkingLevel(...)` and return effective/clamped level + available levels.
- Cancel operations call `AgentSession.abort()` for the current thread session without clearing persisted `thread_sessions` mapping, and return `cancelled: false` when the thread has no active/queued work.
- Share operations call `AgentSession.exportToHtml(...)`, then run `gh gist create` (secret gist by default) and return `{ gistUrl, shareUrl }`.
- Share-viewer URL uses `PI_SHARE_VIEWER_URL` when set to an absolute URL, else defaults to `https://pi.dev/session/`.
- Share operations require GitHub CLI (`gh`) installed and authenticated (`gh auth login`).
- jagc does not duplicate model/thinking state in its own DB.

## Contracts + schema source of truth

- API schemas: `src/shared/api-contracts.ts` (used by server + CLI)
- Run progress event contract: `src/shared/run-progress.ts`
- Migrations: `migrations/001_runs_and_ingest.sql`, `migrations/002_thread_sessions.sql`, `migrations/003_scheduled_tasks.sql`, `migrations/004_scheduled_tasks_rrule.sql`, `migrations/005_input_images.sql`
- Migration runner: `src/server/migrations.ts` (`schema_migrations`; startup apply runs in a SQLite `BEGIN IMMEDIATE` transaction to avoid concurrent bootstrap races)

## Known gaps / intentional limitations

- Telegram webhook mode is intentionally unsupported in core (polling is the only supported Telegram mode).
- Webhook hardening beyond current baseline is pending (signatures/replay protection).
- Linux/systemd and Windows service lifecycle commands are not implemented yet (macOS launchd is first supported target).
- Telegram scheduled-task topic delivery depends on Telegram private-topic mode (`has_topics_enabled`); when topics are unavailable, occurrences fail with actionable `telegram_topics_unavailable` errors (no shared-thread fallback). The capability check is read at adapter startup, so BotFather topic-mode changes require a jagc restart.
- Multi-process one-active-run-per-thread coordination is deferred.
