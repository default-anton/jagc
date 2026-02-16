# Scheduled tasks with per-task execution threads (implementation spec)

Status: **approved for implementation**
Scope: **v1 (end-to-end in jagc server + CLI + thread-scoped API + default extension guidance; Telegram is the first provider implementation)**

This spec is the source of truth for implementing scheduled/recurring tasks in jagc.

## 1) Product decisions (locked)

1. **No basic reminder subsystem.**
   - We only implement scheduled tasks (one-off + recurring).
   - A “reminder” is just a scheduled task whose instructions tell the agent to send a reminder message.

2. **No extension direct DB access.**
   - DB ownership stays in jagc server/store layer.
   - Agent manages tasks through `jagc` CLI commands (invoked via `bash` tool).

3. **No inline-button workflow for task CRUD.**
   - User edits tasks conversationally.
   - Agent uses CLI/API to create/update/delete tasks.

4. **Per-task execution thread from day one.**
   - No shared “scheduled thread.”
   - Each task uses a dedicated execution thread.

5. **Task runs must look like normal jagc runs.**
   - Tool-call progress, thinking snippets, final output, errors are visible in the task thread.
   - `/new`, `/cancel`, `/share`, `/settings`, etc. must work in task threads exactly like creator threads.

---

## 2) Goals and non-goals

### Goals
- Create, list, inspect, update, delete, run-now, enable/disable scheduled tasks.
- Support one-off and recurring schedules.
- Durable scheduler with restart recovery and idempotent run dispatch.
- Per-task execution thread routing across providers.
- Agent-operable task management via `jagc task ... --json`.

### Non-goals (v1)
- No inline-button workflow for task CRUD.
- No direct extension-to-SQLite integration.
- No webhook mode changes.
- No multi-process global task locking (single-process scope, consistent with current v0 runtime model).

---

## 3) UX contract

### 3.1 User-facing behavior
- User asks in their primary thread: “Every weekday at 9am, prepare my day plan.”
- Agent runs `jagc task create ...` via bash.
- jagc stores/schedules the task immediately, but does **not** create the execution thread yet.
- At due time, jagc creates the provider-specific execution thread (if missing) and executes the task as a normal run in that thread.
- User can open that thread and chat there; scheduled runs and manual chat share that thread session.

### 3.2 Thread behavior
- Every execution thread maps to its own `thread_key`.
- All runtime controls (`/new`, `/cancel`, `/share`, etc.) operate per thread.
- Creator thread and execution threads remain independent.

---

## 4) Thread/routing model changes

## 4.1 Canonical thread key model
- Thread keys are provider-prefixed and stable.
- A task stores both:
  - `creator_thread_key` (where task was created)
  - `execution_thread_key` (dedicated per-task execution thread)
- `execution_thread_key` is null until first execution-thread creation.

## 4.2 Telegram routing payload
Introduce a shared routing object for outbound Telegram calls:

```ts
interface TelegramRoute {
  chatId: number;
  messageThreadId?: number;
}
```

Use this for **all** outbound adapter sends/edits/actions/documents/progress.

## 4.3 Telegram inbound mapping
- For `message:text`, if `ctx.message.message_thread_id` exists, use topic thread key.
- For callbacks, derive topic from `ctx.callbackQuery.message.message_thread_id`.
- Runtime controls must use the derived topic thread key, not only `chat_id`.

---

## 5) Scheduled task domain model (DB)

Add migrations `003_scheduled_tasks.sql` (task domain) and `004_scheduled_tasks_rrule.sql` (rrule schedule-kind expansion).

## 5.1 `scheduled_tasks`
Required fields:
- `task_id TEXT PRIMARY KEY` (UUID)
- `title TEXT NOT NULL`
- `instructions TEXT NOT NULL`
- `schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once','cron','rrule'))`
- `once_at TEXT` (UTC ISO, required for `once`)
- `cron_expr TEXT` (required for `cron`)
- `rrule_expr TEXT` (required for `rrule`; normalized `DTSTART` + `RRULE` lines)
- `timezone TEXT NOT NULL` (IANA, e.g. `America/Los_Angeles`)
- `enabled INTEGER NOT NULL DEFAULT 1`
- `next_run_at TEXT` (UTC ISO; null only when disabled/completed once)
- `creator_thread_key TEXT NOT NULL` (thread where task was created)
- `owner_user_key TEXT` (optional)
- `delivery_target TEXT NOT NULL` (JSON blob for provider/platform-specific routing + thread metadata)
  - Example shape: `{"provider":"<provider>","route":{...},"metadata":{...}}`
- `execution_thread_key TEXT` (null until first execution thread is created; then stable thread key)
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `last_run_at TEXT`
- `last_run_status TEXT CHECK (last_run_status IN ('succeeded','failed'))`
- `last_error_message TEXT`

Indexes:
- `scheduled_tasks_due_idx (enabled, next_run_at)`
- `scheduled_tasks_execution_thread_idx (execution_thread_key)`

## 5.2 `scheduled_task_runs`
Required fields:
- `task_run_id TEXT PRIMARY KEY` (UUID)
- `task_id TEXT NOT NULL REFERENCES scheduled_tasks(task_id) ON DELETE CASCADE`
- `scheduled_for TEXT NOT NULL` (UTC ISO occurrence slot)
- `idempotency_key TEXT NOT NULL` (unique)
- `run_id TEXT` (nullable until ingested)
- `status TEXT NOT NULL CHECK (status IN ('pending','dispatched','succeeded','failed'))`
- `error_message TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Constraints/indexes:
- `UNIQUE(task_id, scheduled_for)`
- `UNIQUE(idempotency_key)`
- `scheduled_task_runs_status_idx (status, created_at)`

---

## 6) Scheduler/runtime behavior

## 6.1 Scheduler loop
Implement `ScheduledTaskService` (start/stop lifecycle in `src/server/main.ts`).
- Poll interval default: 5s.
- Steps per tick:
  1. Claim due tasks (`enabled=1 AND next_run_at <= now`) in small batches.
  2. For each due task, create/ensure `scheduled_task_runs` row for `scheduled_for = next_run_at`.
  3. Ensure execution thread exists:
     - if `execution_thread_key` is null, create provider thread lazily and persist routing info in `delivery_target` + `execution_thread_key`.
  4. Advance task `next_run_at`:
     - `once`: set `enabled=0`, `next_run_at=NULL`
     - `cron`: compute first future occurrence strictly `> now` (skip backlog flood)
     - `rrule`: compute first future occurrence strictly `> now` (calendar recurrence)
  5. Dispatch `pending` task-runs via `RunService.ingestMessage(...)`.

## 6.2 Run ingest contract
For each task-run:
- `source`: `task:<task_id>`
- `threadKey`: task `execution_thread_key` (per-task thread)
- `userKey`: task `owner_user_key` (if present)
- `deliveryMode`: `followUp`
- `idempotencyKey`: persisted `idempotency_key`
- `instructions`: built run-instructions block:

```text
[SCHEDULED TASK]
Task: <title>
Task ID: <task_id>
Scheduled for (UTC): <scheduled_for>
Timezone: <timezone>

<instructions>
```

## 6.3 Completion bookkeeping
- When run terminal state is observed, set task-run status `succeeded|failed`.
- Update `scheduled_tasks.last_run_*` fields.
- Must survive restart: on boot, resume processing `pending` and `dispatched` task-runs.

---

## 7) Telegram delivery for scheduled runs

Scheduled runs must render like normal Telegram runs.

## 7.1 Reusable run-delivery path
Refactor current adapter background-delivery logic into reusable unit, used by:
- normal inbound Telegram messages
- scheduled task dispatches

Capabilities required:
- start progress reporter in the target thread
- subscribe run progress
- wait terminal state
- send final markdown/attachments/error in same thread

## 7.2 Routing requirements
All Telegram API calls used in run delivery must include `message_thread_id` when route has topic.
Methods impacted:
- `sendMessage`
- `editMessageText`
- `sendChatAction`
- `deleteMessage`
- `sendDocument`

---

## 8) Telegram topic creation policy

Per-task thread is mandatory.

## 8.1 Topic is created lazily (at due/run-now time)
- Do **not** create topic during task creation.
- On first due occurrence (or `run-now` if no thread yet):
  - create topic with `createForumTopic(chat_id, topicName)`
  - persist returned `message_thread_id` in `delivery_target`
  - derive and persist `execution_thread_key` from chat/topic
- All subsequent runs reuse the persisted thread.

Topic naming:
- `task:<short-id> <title>`
- Trim to Bot API limits (1..128 chars).

## 8.2 If topics unavailable
Fail that occurrence with actionable error (no fallback shared thread):
- `telegram_topics_unavailable`
- message explains bot/forum-topic mode requirement
- task remains configured; future occurrences retry thread creation

---

## 9) API surface (server)

Add task endpoints in HTTP app.

- `POST /v1/threads/:thread_key/tasks`
- `GET /v1/tasks`
- `GET /v1/tasks/:task_id`
- `PATCH /v1/tasks/:task_id`
- `DELETE /v1/tasks/:task_id`
- `POST /v1/tasks/:task_id/run-now`

### 9.1 Create payload
```json
{
  "title": "Daily plan",
  "instructions": "Prepare my daily priorities and ask one clarification question.",
  "schedule": {
    "kind": "cron",
    "cron": "0 9 * * 1-5",
    "timezone": "America/Los_Angeles"
  }
}
```

Alternative recurring payload uses rrule:
```json
{
  "schedule": {
    "kind": "rrule",
    "rrule": "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    "timezone": "America/Los_Angeles"
  }
}
```

Rules:
- No provider-specific routing fields in payload.
- New task is bound to `:thread_key` from the endpoint path (`creator_thread_key`).
- `delivery_target` is initialized from thread context and completed lazily when execution thread is first created.
- Provider-specific execution-thread creation behavior is defined in provider sections.

### 9.2 Update rules
Patchable fields:
- `title`, `instructions`, schedule fields, `enabled`.
- If `title` changes and an execution thread already exists, apply provider-specific thread-title sync best effort and return a warning when sync fails; do not corrupt task row.

### 9.3 Run-now
- Creates a `scheduled_task_runs` row for current timestamp slot and dispatches immediately.
- Does **not** shift recurring schedule anchor (`cron` or `rrule`).

---

## 10) CLI surface (`jagc task`)

Add top-level command group:

- `jagc task create`
- `jagc task list`
- `jagc task get <taskId>`
- `jagc task update <taskId>`
- `jagc task delete <taskId>`
- `jagc task run <taskId> [--wait]`
- `jagc task enable <taskId>`
- `jagc task disable <taskId>`

### 10.1 Command flags (minimum)
`create`
- `--title <text>` (required)
- `--instructions <text>` (required)
- one of:
  - `--once-at <ISO8601>` + `--timezone <IANA>`
  - `--cron <expr>` + `--timezone <IANA>`
  - `--rrule <rule>` + `--timezone <IANA>`
- `--thread-key <threadKey>` (optional; default `$JAGC_THREAD_KEY` when set, else `cli:default`)
- `--json`

`list`
- `--thread-key <threadKey>` (optional filter)
- `--state <all|enabled|disabled>` (default `all`)
- `--json`

`run`
- immediate dispatch by default
- optional `--wait` with `--timeout <seconds>` and `--interval-ms <ms>` for terminal run polling
- `--json`

`update`
- patch flags matching create + `--enable/--disable`
- `--json`

All commands must support machine-readable `--json` output (success and failures when `--json` is set).

---

## 11) Agent guidance (runtime context + dedicated skill)

Keep the runtime extension terse and move task-operating detail into a dedicated skill.

Requirements:
- Add/update `defaults/skills/task-ops/SKILL.md` with canonical command patterns and low-turn workflows.
- Keep `defaults/extensions/20-runtime-harness-context.ts` minimal: point to the skill, enforce CLI/API-only task management, and keep lazy execution-thread behavior explicit.
- Explicitly prohibit direct DB edits.
- Include run-now + wait workflow (`jagc task run <taskId> --wait ... --json`) in the skill.
- Include post-mutation verification policy in the skill (`mutation response first`, then `task get/list` for confirmation/troubleshooting).

---

## 12) Testing plan (must pass)

Use existing canonical loops:
- `pnpm test`
- `pnpm test:telegram`
- `pnpm release:gate`

Add/extend tests:

### Provider-agnostic coverage

1. **Migration/store tests**
   - new tables exist and constraints/indexes enforce invariants.

2. **Scheduler tests**
   - due one-off dispatches exactly once and disables task.
   - recurring advances `next_run_at` to future slot.
   - restart recovery resumes pending/dispatched runs.

3. **Server API tests**
   - task CRUD + run-now happy path and validation failures.

4. **CLI tests**
   - argument validation and JSON output shape.

### Telegram v1 coverage

5. **Telegram adapter tests**
   - topic-aware thread key mapping from inbound message/callback.
   - all outbound methods include `message_thread_id` in topic threads.
   - `/new` in a task thread resets only that thread session.

6. **Telegram Bot API clone tests**
   - support `createForumTopic` and payload assertions for `message_thread_id`.

7. **System smoke**
   - create recurring task (no topic yet) -> first due/run-now creates topic -> scheduled execution posts progress+final output to that topic.

---

## 13) Documentation updates required in implementation PR

Because this changes runtime + CLI behavior, the implementation PR must update:
- `README.md` (new task commands + operator flow)
- `docs/architecture.md` (scheduler + task domain + topic routing)
- `docs/testing.md` (new feedback loops)
- `CHANGELOG.md` under `[Unreleased]`

---

## 14) Implementation checklist (copy into PR)

### Provider-agnostic
- [ ] Add migrations for scheduled tasks + task runs
- [ ] Add store/service layer for tasks and scheduler loop
- [ ] Add reusable run-delivery path and use it for scheduled runs
- [ ] Add HTTP task endpoints + schemas + client bindings
- [ ] Add `jagc task` CLI commands
- [ ] Update `defaults/extensions/20-runtime-harness-context.ts` with task guidance
- [ ] Add/adjust provider-agnostic tests listed above
- [ ] Update README/architecture/testing/changelog

### Telegram v1
- [ ] Add topic-aware thread key + route-aware Telegram sends
- [ ] Extend Telegram clone for topic APIs/fields
- [ ] Add/adjust Telegram-specific tests listed above
