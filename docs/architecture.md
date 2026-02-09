# jagc architecture (current implementation)

This doc is the implementation snapshot (not design intent).

- Current operator-facing contract: [`README.md`](../README.md)
- Deferred/historical notes: [`docs/future.md`](./future.md)

## Implemented surface (v0)

### HTTP API

- Core run lifecycle: `GET /healthz`, `POST /v1/messages`, `GET /v1/runs/:run_id`
- OAuth broker: `GET /v1/auth/providers`, `POST /v1/auth/providers/:provider/login`, `GET /v1/auth/logins/:attempt_id`, `POST /v1/auth/logins/:attempt_id/input`, `POST /v1/auth/logins/:attempt_id/cancel`
- Runtime controls: `GET /v1/models`, `GET /v1/threads/:thread_key/runtime`, `PUT /v1/threads/:thread_key/model`, `PUT /v1/threads/:thread_key/thinking`, `DELETE /v1/threads/:thread_key/session`

### CLI

- `jagc health`
- `jagc message`
- `jagc run wait`
- `jagc auth providers`, `jagc auth login <provider>`
- `jagc new`, `jagc model list|get|set`, `jagc thinking get|set`

### Runtime/adapters

- Executors: `echo` (deterministic), `pi` (real agent)
- Telegram polling adapter (personal chats) with `/settings`, `/new`, `/model`, `/thinking`, `/auth`
- Postgres persistence (`runs`, ingest idempotency, `thread_sessions`)
- In-process run scheduler for dispatch/recovery (no external workflow engine)

## Workspace bootstrap

- Startup bootstraps `JAGC_WORKSPACE_DIR` (`~/.jagc` by default) with directory mode `0700`.
- Bootstrap creates default `SYSTEM.md`, `AGENTS.md`, and `settings.json` from repo templates when missing (never overwrites existing files).
- Default `settings.json` includes bootstrap pi packages (`pi-librarian`, `pi-subdir-context`) but remains user-editable after creation.
- Bootstrap also ensures workspace `.gitignore` has `.sessions/`, `auth.json`, and `git/` entries.

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

- Source of truth is Postgres run state (`runs.status`).
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
- In-memory session cache is hot-path only; Postgres mapping is source of truth across restarts.

### Same-thread coordination (non-obvious)

`ThreadRunController` coordinates same-thread turns against a single pi session:

- First active run uses `session.prompt(...)`.
- Additional same-thread runs queue via `session.followUp(...)` or `session.steer(...)`.
- Run completion attribution comes from session events (not prompt promise timing), using user/assistant boundary events.

Operational note:

- With the in-process scheduler feeding a per-thread controller, same-thread `followUp`/`steer` messages can be delivered while a session is active.
- If the process crashes, pending `running` rows are replayed from Postgres on recovery.

## Telegram polling behavior

- Ingest source: grammY long polling (personal chats).
- Thread mapping: `thread_key = telegram:chat:<chat_id>`.
- User mapping: `user_key = telegram:user:<from.id>`.
- Default delivery mode for normal text messages: `followUp` (`/steer` is explicit).
- Telegram `/new` and API `DELETE /v1/threads/:thread_key/session` abort/dispose the current thread session, clear persisted `thread_sessions` mapping, and cause the next message to create a fresh pi session.
- Adapter starts a per-run progress reporter (in-chat status message + typing indicator) as soon as a run is ingested.
- Progress is driven by run-level events emitted from `RunService` and pi session events forwarded by `ThreadRunController` (`assistant_text_delta`, `assistant_thinking_delta`, `tool_execution_*`, turn/agent lifecycle).
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

### Runtime controls (model/thinking)

- `PiRunExecutor` is source of truth for per-thread runtime state.
- Model updates call `AgentSession.setModel(...)` (validated via pi `ModelRegistry`, persisted via `SettingsManager`).
- Thinking updates call `AgentSession.setThinkingLevel(...)` and return effective/clamped level + available levels.
- jagc does not duplicate model/thinking state in its own DB.

## Contracts + schema source of truth

- API schemas: `src/shared/api-contracts.ts` (used by server + CLI)
- Run progress event contract: `src/shared/run-progress.ts`
- Migrations: `migrations/001_runs_and_ingest.sql`, `migrations/002_thread_sessions.sql`
- Migration runner: `src/server/migrations.ts` (`schema_migrations`)

## Known gaps / intentional limitations

- Telegram webhook mode is not implemented (polling is implemented).
- Webhook hardening beyond current baseline is pending (signatures/replay protection).
- CI merge-gate automation is not wired yet; local release gate is the current gate (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`).
- Multi-process one-active-run-per-thread coordination is deferred.
