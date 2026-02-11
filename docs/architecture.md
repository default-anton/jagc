# jagc architecture (current implementation)

This doc is the implementation snapshot (not design intent).

- Current operator-facing contract: [`README.md`](../README.md)
- Deferred/historical notes: [`docs/future.md`](./future.md)

## Implemented surface (v0)

### HTTP API

- Core run lifecycle: `GET /healthz`, `POST /v1/messages`, `GET /v1/runs/:run_id`
- OAuth broker: `GET /v1/auth/providers`, `POST /v1/auth/providers/:provider/login`, `GET /v1/auth/logins/:attempt_id`, `POST /v1/auth/logins/:attempt_id/input`, `POST /v1/auth/logins/:attempt_id/cancel`
- Runtime controls: `GET /v1/models`, `GET /v1/threads/:thread_key/runtime`, `PUT /v1/threads/:thread_key/model`, `PUT /v1/threads/:thread_key/thinking`, `DELETE /v1/threads/:thread_key/session`, `POST /v1/threads/:thread_key/share`

### CLI

- `jagc health`
- `jagc message`
- `jagc run wait`
- `jagc auth providers`, `jagc auth login <provider>`
- `jagc new`, `jagc share`, `jagc defaults sync`, `jagc packages install|remove|update|list|config`, `jagc model list|get|set`, `jagc thinking get|set`
- Service lifecycle + diagnostics: `jagc install|status|restart|uninstall|doctor` (macOS launchd implementation, future Linux/Windows planned)

### Runtime/adapters

- Executors: `echo` (deterministic), `pi` (real agent)
- `PiRunExecutor` creates pi sessions with a custom `DefaultResourceLoader` that disables SDK built-in AGENTS.md/skills loading; equivalent context is injected by bundled workspace extensions in `defaults/extensions/*.ts` (runtime/harness context, global AGENTS hierarchy, available skills metadata, local pi docs/examples paths, and Codex harness notes)
- Telegram polling adapter (personal chats) with `/settings`, `/new`, `/share`, `/model`, `/thinking`, `/auth`
- SQLite persistence (`runs`, ingest idempotency, `thread_sessions`)
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
- Default `settings.json` includes bootstrap pi packages (`pi-librarian`, `pi-subdir-context`) but remains user-editable after creation.
- `jagc packages ...` is a thin wrapper around the bundled `@mariozechner/pi-coding-agent` package manager CLI (`dist/cli.js`), executed with `PI_CODING_AGENT_DIR=<workspace>` and `cwd=<workspace>` so package operations target the jagc workspace and do not depend on a globally installed `pi` binary.
- Bootstrap initializes `JAGC_WORKSPACE_DIR` as a local git repository (`git init`) when `.git` is missing.
- Bootstrap also ensures workspace `.gitignore` has `.sessions/`, `auth.json`, `git/`, `service.env`, `service.env.snapshot`, `jagc.sqlite`, `jagc.sqlite-shm`, and `jagc.sqlite-wal` entries.

## macOS service lifecycle (CLI-managed)

- `jagc install` writes a per-user launch agent at `~/Library/LaunchAgents/<label>.plist` (`com.jagc.server` by default), then `launchctl bootstrap` + `kickstart` starts the service.
- launchd runs `node --env-file-if-exists=<workspace>/service.env.snapshot --env-file-if-exists=<workspace>/service.env <installed package>/dist/server/main.mjs`.
- Node runtime requirement for this launch path is `>=20.19.0 <21` or `>=22.9.0`.
- `jagc install` always regenerates `<workspace>/service.env.snapshot` from the user's login shell (PATH/tooling env) and creates `<workspace>/service.env` when missing.
- `service.env` is never overwritten by `jagc install` once it exists; user edits are picked up after `jagc restart`.
- launchd environment variables include `JAGC_WORKSPACE_DIR`, `JAGC_DATABASE_PATH`, `JAGC_HOST`, `JAGC_PORT`, `JAGC_RUNNER`, and optional `JAGC_TELEGRAM_BOT_TOKEN`.
- Logs default to `$JAGC_WORKSPACE_DIR/logs/server.out.log` and `server.err.log`.
- `jagc status` inspects launchd (`launchctl print`) and API health (`/healthz`).
- `jagc restart` issues `launchctl kickstart -k` and waits for `/healthz`.
- `jagc uninstall` removes the launch agent and unloads it; `--purge-data` additionally deletes the workspace directory.

## Request/execution flow

### 1) Message ingest (`POST /v1/messages`)

- `src/server/app.ts` validates payload.
- Header/body idempotency key mismatch returns `400`.
- `RunService.ingestMessage(...)` writes/gets run via `RunStore.createRun(...)`.
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

## Session/thread model (pi executor)

- Session identity is per `thread_key`.
- `thread_sessions` persists `thread_key`, `session_id`, `session_file`.
- `PiRunExecutor` reopens persisted sessions when possible; creates/persists when missing/invalid.
- In-memory session cache is hot-path only; SQLite mapping is source of truth across restarts.

### Same-thread coordination (non-obvious)

`ThreadRunController` coordinates same-thread turns against a single pi session:

- First active run uses `session.prompt(...)`.
- Additional same-thread runs queue via `session.followUp(...)` or `session.steer(...)`.
- Run completion attribution comes from session events (not prompt promise timing), using user/assistant boundary events.

Operational note:

- With the in-process scheduler feeding a per-thread controller, same-thread `followUp`/`steer` messages can be delivered while a session is active.
- If the process crashes, pending `running` rows are replayed from SQLite on recovery.

## Telegram polling behavior

- Ingest source: grammY long polling (personal chats).
- Thread mapping: `thread_key = telegram:chat:<chat_id>`.
- User mapping: `user_key = telegram:user:<from.id>`.
- Default delivery mode for normal text messages: `followUp` (`/steer` is explicit).
- Telegram `/new` and API `DELETE /v1/threads/:thread_key/session` abort/dispose the current thread session, clear persisted `thread_sessions` mapping, and cause the next message to create a fresh pi session.
- Telegram `/share` and API `POST /v1/threads/:thread_key/share` export the current thread session to HTML and upload it as a secret GitHub gist; response includes both gist URL and share-viewer URL.
- Adapter starts a per-run progress reporter (in-chat append-style progress message + typing indicator) as soon as a run is ingested.
- Progress is driven by run-level events emitted from `RunService` and pi session events forwarded by `ThreadRunController` (`assistant_text_delta`, `assistant_thinking_delta`, `tool_execution_*`, turn/agent lifecycle), rendered as compact append-log lines (`>` for tool calls with args-focused snippets, `~` for short thinking snippets); tool call completion edits the original `>` line in place to append status + duration (`[✓] done (0.4s)` / `[✗] failed (0.4s)`).
- Until the first visible thinking/tool snippet arrives, the progress message shows a short single-word placeholder (for immediate feedback); once the first snippet arrives, that placeholder is removed, and if the run finishes without any snippets, the placeholder message is deleted.
- Status updates are edit-throttled and retry-aware for Telegram rate limits (`retry_after`).
- Adapter waits for terminal run status and replies with output/error.
- If foreground wait exceeds adapter timeout, Telegram receives a "still running" notice and the adapter continues waiting in the background, then posts final output when complete.
- `/model` and `/thinking` use button pickers; text args are intentionally unsupported.
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

### Runtime controls (model/thinking/share)

- `PiRunExecutor` is source of truth for per-thread runtime state.
- Model updates call `AgentSession.setModel(...)` (validated via pi `ModelRegistry`, persisted via `SettingsManager`).
- Thinking updates call `AgentSession.setThinkingLevel(...)` and return effective/clamped level + available levels.
- Share operations call `AgentSession.exportToHtml(...)`, then run `gh gist create` (secret gist by default) and return `{ gistUrl, shareUrl }`.
- Share-viewer URL uses `PI_SHARE_VIEWER_URL` when set to an absolute URL, else defaults to `https://pi.dev/session/`.
- Share operations require GitHub CLI (`gh`) installed and authenticated (`gh auth login`).
- jagc does not duplicate model/thinking state in its own DB.

## Contracts + schema source of truth

- API schemas: `src/shared/api-contracts.ts` (used by server + CLI)
- Run progress event contract: `src/shared/run-progress.ts`
- Migrations: `migrations/001_runs_and_ingest.sql`, `migrations/002_thread_sessions.sql`
- Migration runner: `src/server/migrations.ts` (`schema_migrations`; startup apply runs in a SQLite `BEGIN IMMEDIATE` transaction to avoid concurrent bootstrap races)

## Known gaps / intentional limitations

- Telegram webhook mode is intentionally unsupported in core (polling is the only supported Telegram mode).
- Webhook hardening beyond current baseline is pending (signatures/replay protection).
- Linux/systemd and Windows service lifecycle commands are not implemented yet (macOS launchd is first supported target).
- Multi-process one-active-run-per-thread coordination is deferred.
