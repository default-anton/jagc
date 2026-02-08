# jagc architecture (current implementation)

This document describes the **current code architecture** (not aspirational design).

For future/deferred ideas, see [`docs/future.md`](./future.md).

## Scope

Current implemented vertical slice:

- HTTP API:
  - `GET /healthz`
  - `POST /v1/messages`
  - `GET /v1/runs/:run_id`
  - `GET /v1/auth/providers`
  - `POST /v1/auth/providers/:provider/login`
  - `GET /v1/auth/logins/:attempt_id`
  - `POST /v1/auth/logins/:attempt_id/input`
  - `POST /v1/auth/logins/:attempt_id/cancel`
  - `GET /v1/models`
  - `GET /v1/threads/:thread_key/runtime`
  - `PUT /v1/threads/:thread_key/model`
  - `PUT /v1/threads/:thread_key/thinking`
- CLI:
  - `jagc health`
  - `jagc message`
  - `jagc run wait`
  - `jagc auth providers`
  - `jagc auth login <provider>`
  - `jagc model list|get|set`
  - `jagc thinking get|set`
- Runtime executors: `echo` (deterministic) and `pi` (real agent)
- Telegram polling adapter (personal chats) with button-based runtime controls (`/settings`, `/model`, `/thinking`, `/auth`)
- Durable run scheduling/recovery via DBOS
- Postgres persistence for runs, idempotency keys, and `thread_key -> session` mapping

## Request and execution flow

### 1) Ingest (`POST /v1/messages`)

1. `app.ts` validates payload + optional `Idempotency-Key` header.
2. If both body/header idempotency keys are present and differ, request is rejected (`400`).
3. `RunService.ingestMessage(...)` is called.
4. `RunStore.createRun(...)` inserts a `running` run (or returns existing run when deduplicated).
5. Non-deduplicated runs are durably enqueued with DBOS (`workflowID = run_id`).
6. API responds `202` with run envelope (`run_id`, `status`, `output`, `error`).

### 1b) Telegram polling ingest

- `TelegramPollingAdapter` consumes personal chat messages via grammY long polling.
- Normal text messages are normalized to the same ingest contract and passed to `RunService.ingestMessage(...)` with:
  - `source = telegram`
  - `thread_key = telegram:chat:<chat_id>`
  - `user_key = telegram:user:<from.id>`
  - `delivery_mode = followUp` by default (`/steer` is explicit opt-in).
- Adapter waits for terminal run status and replies back to chat with final output/error.
- Adapter-level controls:
  - `/settings` opens runtime settings menu
  - `/model` opens model picker (button-based)
  - `/thinking` opens thinking picker (button-based)
  - `/auth` opens OAuth provider login controls (button-based picker + status)
  - `/auth input <value>` submits prompt/manual-code input for the active login attempt
  - text arguments for `/model` and `/thinking` are intentionally not supported

### 2) Durable execution

1. DBOS dequeues `jagc.execute_run`.
2. Scheduler callback invokes `RunService.executeRunById(run_id)`.
3. `RunService` loads run, skips if no longer `running`.
4. `RunExecutor.execute(run)` returns structured `RunOutput` or throws.
5. `RunService` performs the status transition:
   - success -> `markSucceeded(run_id, output)`
   - failure -> `markFailed(run_id, message)`

### 3) Polling (`GET /v1/runs/:run_id`)

- Returns normalized run response.
- Failed runs include `error.message`.

## Durability model

### DBOS durability

- Runs are scheduled as DBOS workflows keyed by `run_id`.
- Queue `jagc_runs` is partitioned by `thread_key` and enforces per-partition concurrency = 1 (strict one-active-run-per-thread globally).
- On process startup, DBOS recovery resumes pending queue work.

### Service-level recovery pass

- `RunService.init()` performs an immediate scan of `runs.status='running'` and ensures each run is enqueued.
- A periodic recovery pass (15s interval) repeats this check to close gaps between DB state and queue state.

## Session model (pi executor)

- Session identity remains per `thread_key`.
- `thread_sessions` table persists:
  - `thread_key`, `session_id`, `session_file`
- `PiRunExecutor` behavior:
  - look up persisted mapping
  - reopen session file when present
  - create/persist new session when missing or invalid
- In-process cache is used for hot reuse (`Map<threadKey, AgentSession>`), DB is source of truth across restarts.
- Per-thread turn coordination is implemented by `ThreadRunController`:
  - first in-flight run is sent with `session.prompt(...)`
  - additional same-thread runs are queued with `session.followUp(...)` or `session.steer(...)`
  - run completion is attributed from session events, not from `prompt()` promise timing

## Concurrency semantics

- Different threads can run concurrently.
- Strict one-active-run-per-thread is enforced globally by DBOS queue partitioning:
  - queue: `jagc_runs`
  - partition key: `thread_key`
  - per-partition concurrency: `1`
- Same-thread messages are accepted while a run is active (not rejected) and durably queued as runs.
- Because queue concurrency is enforced at one run per thread, same-thread run workflows do not overlap.
- Same-thread run completion attribution in the pi executor uses session event boundaries:
  - a run becomes active when its user message is delivered (`message_start` role=`user`)
  - assistant snapshots are taken on `message_end` role=`assistant`
  - a run is finalized when the next user message is delivered or at `agent_end`
- This avoids mis-attribution when pi `prompt(..., { streamingBehavior })` resolves before queued work is actually completed.
- Note: immediate in-flight interruption of run N by run N+1 (`steer`) across separate run records is not guaranteed under strict per-thread run serialization. It requires a future thread-owned draining loop model.

## OAuth login broker

For `pi` runner mode, jagc exposes OAuth login bridging over HTTP:

- `POST /v1/auth/providers/:provider/login`
- `GET /v1/auth/logins/:attempt_id`
- `POST /v1/auth/logins/:attempt_id/input`
- `POST /v1/auth/logins/:attempt_id/cancel`

Implementation details:

- `PiAuthService` wraps pi `AuthStorage` + `ModelRegistry`.
- `OAuthLoginBroker` keeps in-memory attempt state and bridges `AuthStorage.login()` callbacks (`onAuth`, `onPrompt`, `onManualCodeInput`, `onProgress`).
- Attempts are owner-scoped (`X-JAGC-Auth-Owner`) and never shared across owners.
- Follow-up endpoints (`GET`, `/input`, `/cancel`) require owner header and return `404` on owner mismatch.
- Overflow pruning removes only terminal attempts; if broker capacity is still exhausted with active attempts, new starts return `429` (`auth_login_capacity_exceeded`) rather than evicting in-flight attempts.
- Terminal credentials are persisted by pi to workspace `auth.json`.

## Thread runtime controls (model/thinking)

For `pi` runner mode, jagc exposes model/thinking controls per `thread_key`:

- `GET /v1/threads/:thread_key/runtime`
- `PUT /v1/threads/:thread_key/model`
- `PUT /v1/threads/:thread_key/thinking`

Implementation details:

- `PiRunExecutor` is the source of truth for thread session runtime state.
- Model changes call `AgentSession.setModel(...)`, which validates auth through pi `ModelRegistry` and persists defaults via pi `SettingsManager`.
- Thinking changes call `AgentSession.setThinkingLevel(...)` and return the clamped effective level plus available levels for the active model.
- No model/thinking state is duplicated in jagc DB.

## API contract source of truth

Shared schema file: `src/shared/api-contracts.ts`

- Request schemas (`postMessageRequestSchema`, `runParamsSchema`)
- Response schemas (`runResponseSchema`, auth schemas)
- Used by:
  - server request handling (`src/server/app.ts`)
  - CLI response parsing (`src/cli/client.ts`)

## Storage schema

Managed by SQL migrations in `migrations/`:

- `001_runs_and_ingest.sql`
  - `runs`
  - `message_ingest`
  - indexes on `runs(thread_key, status)` and `runs(created_at)`
- `002_thread_sessions.sql`
  - `thread_sessions`

Migration runner: `src/server/migrations.ts` (`schema_migrations` table).

## Known gaps / intentional limitations

- No CI merge-gate wiring yet (local gate exists).
- Telegram webhook mode is not implemented yet (polling is implemented).
- No webhook auth/hardening implementation yet beyond documented baseline.
