# jagc architecture (current implementation)

This is the architecture snapshot for implemented behavior (not design intent).

- Operator-facing contract and setup: [`README.md`](../README.md)
- Operational/service details: [`docs/operations.md`](./operations.md)
- Telegram adapter contract: [`docs/telegram.md`](./telegram.md)

## Scope (v1)

jagc is a single-process server + control plane where:

- **Telegram is the primary UX**
- HTTP API + CLI are setup/control/debug surfaces
- run durability/recovery is backed by SQLite
- real agent execution is via in-process pi SDK sessions

## Implemented interfaces (summary)

- **HTTP API:** health, message ingest/run polling, scheduled tasks, OAuth broker, runtime controls
- **CLI:** run/task/auth/runtime/service controls
- **Adapters:** Telegram long polling for personal chats + topic routing

For complete command/API behavior and operator usage, see [`README.md`](../README.md) and linked detail docs.

## System model

Core components:

1. **Fastify server** (`src/server/app.ts`) validates requests, exposes API, and emits request telemetry.
2. **RunService + LocalRunScheduler** orchestrate ingest, dispatch, terminalization, and restart recovery.
3. **PiRunExecutor** executes runs against per-thread pi sessions and persists `thread_key -> session`.
4. **ScheduledTaskService** claims due tasks and dispatches deterministic task occurrences.
5. **SQLite state** persists runs, sessions, scheduled tasks/runs, ingest idempotency, and staged images.
6. **Telegram adapter** maps inbound updates to thread/user keys and drives progress + final delivery.
7. **Workspace bootstrap** seeds default prompt/config files plus bundled skills, extensions, and markdown memory scaffolding under `memory/`.

## Core flows

### Message/run flow

1. Ingest (`POST /v1/messages`) validates payload + idempotency and creates/returns run state.
2. Scheduler dispatches eligible runs in-process and serializes dispatch per `thread_key`.
3. Executor submits prompt/follow-up/steer to pi session and streams progress events.
4. Run is finalized as succeeded/failed with normalized `output`/`error` envelope.
5. Polling (`GET /v1/runs/:run_id`) reads durable run state.

### Recovery flow

- Source of truth is SQLite `runs.status`.
- Startup + periodic recovery re-enqueue `running` rows missing from in-process work sets.
- Scheduler-level run-id dedupe makes ingest/recovery races safe.

### Scheduled task flow

- Due tasks are claimed from `scheduled_tasks`, occurrence rows written to `scheduled_task_runs`, and occurrences dispatched via normal message ingest path.
- Pending/dispatched occurrences reconcile against terminal run state; `last_run_*` fields are updated durably.

## Data ownership

- **`runs`**: run lifecycle/status/output/error and ingest idempotency behavior.
- **`thread_sessions`**: durable session mapping (`thread_key`, `session_id`, `session_file`).
- **`scheduled_tasks` / `scheduled_task_runs`**: task definitions + occurrence execution history.
- **`input_images`**: temporary staged images for API/Telegram ingest and run-linked submissions.
- **`memory/**/*.md`**: markdown-first curated assistant memory in workspace files (bootstrap scaffolds defaults; agent curates contents via per-turn memory checkpoint triage + in-place updates).
- **pi settings/session state**: model + thinking state (not duplicated in jagc DB).

Schemas/migrations source of truth:

- API contracts: `src/shared/api-contracts.ts`
- Run progress event contracts: `src/shared/run-progress.ts`
- Migrations: `migrations/001_runs_and_ingest.sql`, `002_thread_sessions.sql`, `003_scheduled_tasks.sql`, `004_scheduled_tasks_rrule.sql`, `005_input_images.sql`, `006_input_images_telegram_update_id.sql`
- Migration runner: `src/server/migrations.ts`

## Non-obvious invariants

- Default same-thread delivery mode is `followUp`; `steer` is explicit opt-in.
- Same-thread ordering is enforced by per-thread session controllers in a single process.
- Dispatch serialization is per `thread_key` (different threads can run concurrently).
- Local CLI usage is unauthenticated; webhook ingress requires token auth.
- SQLite default path is `$JAGC_WORKSPACE_DIR/jagc.sqlite`.

## Deferred / intentional limitations

- Telegram webhook mode is intentionally unsupported in core (polling only).
- Linux/systemd and Windows service lifecycle commands are not implemented yet (macOS launchd first).
- Multi-process/global one-active-run-per-thread coordination is deferred.
- Telegram scheduled-task topic delivery requires Telegram private-topic capability.

## Detail docs map

- Operator contract + command/API usage: [`README.md`](../README.md)
- Operations/bootstrap/service lifecycle: [`docs/operations.md`](./operations.md)
- Telegram adapter behavior: [`docs/telegram.md`](./telegram.md)
- Auth + OAuth broker details: [`docs/auth.md`](./auth.md)
- Testing loops: [`docs/testing.md`](./testing.md)
- Release process: [`docs/release.md`](./release.md)
- Tooling setup: [`docs/tooling.md`](./tooling.md)
