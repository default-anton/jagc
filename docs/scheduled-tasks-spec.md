# Scheduled tasks (implemented contract)

Status: **implemented**
Last validated: **2026-02-15**

This is the authoritative reference for current scheduled-task behavior.

Related docs:
- `docs/architecture.md`
- `docs/testing.md`

---

## 1) Scope

Implemented:
- Task lifecycle: create/list/get/update/delete/run-now/enable/disable.
- Schedule kinds: `once`, `cron`, `rrule`.
- Durable scheduler + restart recovery.
- Per-task execution thread model.
- Telegram delivery in dedicated task topics.

Not implemented:
- Separate reminder subsystem.
- Inline Telegram task-CRUD UI.
- Multi-process global scheduler locking.

Primary code:
- Service: `src/server/scheduled-task-service.ts`
- Store: `src/server/scheduled-task-store.ts`
- API routes: `src/server/app-task-routes.ts`
- CLI: `src/cli/task-commands.ts`

---

## 2) Threading model

Each task stores:
- `creator_thread_key`: where task was created.
- `execution_thread_key`: dedicated run thread (allocated lazily).

Delivery target is persisted in `delivery_target` (provider/route metadata).

Code:
- Types: `src/server/scheduled-task-types.ts`
- Derivation: `src/server/scheduled-task-helpers.ts` (`deliveryTargetFromCreatorThread`)

Telegram keys:
- Base: `telegram:chat:<chat_id>`
- Topic: `telegram:chat:<chat_id>:topic:<message_thread_id>`
- `message_thread_id=1` normalized to base chat.

Code: `src/shared/telegram-threading.ts`

---

## 3) Storage model (SQLite)

Migrations:
- `migrations/003_scheduled_tasks.sql`
- `migrations/004_scheduled_tasks_rrule.sql`

Tables:
- `scheduled_tasks`
  - schedule: `schedule_kind`, `once_at`, `cron_expr`, `rrule_expr`, `timezone`
  - routing/state: `creator_thread_key`, `delivery_target`, `execution_thread_key`, `enabled`, `next_run_at`
  - last-result fields: `last_run_at`, `last_run_status`, `last_error_message`
- `scheduled_task_runs`
  - occurrence/run linkage: `scheduled_for`, `idempotency_key`, `run_id`, `status`, `error_message`

Invariants:
- schedule-kind check enforces exactly one active schedule payload.
- `UNIQUE(task_id, scheduled_for)`.
- `UNIQUE(idempotency_key)`.
- status in `pending|dispatched|succeeded|failed`.

Indexes:
- `scheduled_tasks_due_idx (enabled, next_run_at)`
- `scheduled_tasks_execution_thread_idx (execution_thread_key)`
- `scheduled_task_runs_status_idx (status, created_at)`

---

## 4) Scheduler behavior

`ScheduledTaskService` runs in-process (default 5s tick).

Tick pipeline:
1. `processDueTasks()`
2. `resumePendingTaskRuns()`
3. `reconcileDispatchedTaskRuns()`

Due-task flow:
1. Create/get occurrence row (`scheduled_task_runs`) using deterministic idempotency key:
   - `task:<task_id>:scheduled_for:<iso>`
2. Advance schedule:
   - `once` → disable + clear `next_run_at`
   - `cron`/`rrule` → next future slot (`> now`)
3. Ensure execution thread (lazy)
4. Dispatch via `RunService.ingestMessage(...)`

Ingest contract:
- `source = task:<task_id>`
- `threadKey = execution_thread_key`
- `deliveryMode = followUp`
- `idempotencyKey = scheduled_task_runs.idempotency_key`
- payload envelope from `buildTaskRunInstructions(...)`

Recovery:
- pending runs are resumed.
- dispatched runs are reconciled with run state and finalized.

Code:
- Service: `src/server/scheduled-task-service.ts`
- Helpers: `src/server/scheduled-task-helpers.ts`
- Schedule math: `src/server/scheduled-task-schedule.ts`

---

## 5) run-now semantics

`POST /v1/tasks/:task_id/run-now`:
- creates occurrence at current UTC timestamp,
- dispatches immediately,
- does not shift recurring schedule anchor.

Current behavior: run-now is allowed even if task is disabled.

Code/tests:
- Route: `src/server/app-task-routes.ts`
- Service: `src/server/scheduled-task-service.ts` (`runNow`)
- Coverage: `tests/server-api.test.ts`, `tests/scheduled-task-service.test.ts`

---

## 6) Telegram provider behavior

Execution-thread policy:
- Task topic is created lazily on first due/run-now if missing.
- No topic created during task create.
- Resulting topic route is persisted and becomes `execution_thread_key`.

Topic naming:
- **title only** (trimmed to 1..128 chars), no `task:<id>` prefix.
- empty/whitespace title fallback: `task`.

Title sync:
- On task title update, sync (`editForumTopic`) is best-effort when execution topic exists.
- Skip sync for legacy creator-origin topics (same topic id as creator thread).
- Sync failures return warnings; task update still succeeds.

Topic-unavailable behavior:
- No shared-thread fallback.
- `telegram_topics_unavailable` errors are surfaced with guidance.

Delivery path:
- Scheduled runs reuse normal Telegram run-delivery pipeline.
- Topic routes include `message_thread_id` across send/edit/action/delete/document flows.

Code:
- Bridge + create/sync/deliver: `src/adapters/telegram-polling.ts`
- Title formatting: `src/adapters/telegram-polling-helpers.ts`
- Shared delivery: `src/adapters/telegram-run-delivery.ts`
- Progress routing: `src/adapters/telegram-progress.ts`
- Server bridge wiring: `src/server/main.ts`

---

## 7) API + CLI contract

HTTP endpoints:
- `POST /v1/threads/:thread_key/tasks`
- `GET /v1/tasks`
- `GET /v1/tasks/:task_id`
- `PATCH /v1/tasks/:task_id`
- `DELETE /v1/tasks/:task_id`
- `POST /v1/tasks/:task_id/run-now`

Schemas:
- `src/shared/api-contracts.ts`

CLI commands:
- `jagc task create|list|get|update|delete|run|enable|disable`
- `create` requires exactly one of `--once-at|--cron|--rrule` plus `--timezone`
- default create thread: `$JAGC_THREAD_KEY` else `cli:default`
- `run --wait` supports `--timeout` and `--interval-ms`
- `--json` supports machine-readable success and error output

Code:
- Commands: `src/cli/task-commands.ts`
- Client: `src/cli/client.ts`
- JSON errors: `src/cli/common.ts`

---

## 8) Test map

- Store/schema: `tests/scheduled-task-store.test.ts`
- Service/recovery/Telegram thread allocation: `tests/scheduled-task-service.test.ts`
- API contract: `tests/server-api.test.ts`
- CLI + client: `tests/cli-task-commands.test.ts`, `tests/cli-client.test.ts`
- Telegram e2e scheduled delivery: `tests/telegram-system-smoke.test.ts`
- Telegram helper/formatting checks: `tests/telegram-polling.test.ts`

Canonical loops:
- `pnpm smoke`
- `pnpm test`
- `pnpm test:telegram`
- `pnpm release:gate`
