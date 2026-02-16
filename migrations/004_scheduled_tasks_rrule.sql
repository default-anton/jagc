CREATE TABLE scheduled_task_runs_backup AS
SELECT
  task_run_id,
  task_id,
  scheduled_for,
  idempotency_key,
  run_id,
  status,
  error_message,
  created_at,
  updated_at
FROM scheduled_task_runs;

DROP TABLE scheduled_task_runs;

ALTER TABLE scheduled_tasks RENAME TO scheduled_tasks_pre_rrule;

CREATE TABLE scheduled_tasks (
  task_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('once', 'cron', 'rrule')),
  once_at TEXT,
  cron_expr TEXT,
  rrule_expr TEXT,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  creator_thread_key TEXT NOT NULL,
  owner_user_key TEXT,
  delivery_target TEXT NOT NULL,
  execution_thread_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_run_at TEXT,
  last_run_status TEXT CHECK (last_run_status IN ('succeeded', 'failed')),
  last_error_message TEXT,
  CHECK (
    (schedule_kind = 'once' AND once_at IS NOT NULL AND cron_expr IS NULL AND rrule_expr IS NULL) OR
    (schedule_kind = 'cron' AND once_at IS NULL AND cron_expr IS NOT NULL AND rrule_expr IS NULL) OR
    (schedule_kind = 'rrule' AND once_at IS NULL AND cron_expr IS NULL AND rrule_expr IS NOT NULL)
  )
);

INSERT INTO scheduled_tasks (
  task_id,
  title,
  instructions,
  schedule_kind,
  once_at,
  cron_expr,
  rrule_expr,
  timezone,
  enabled,
  next_run_at,
  creator_thread_key,
  owner_user_key,
  delivery_target,
  execution_thread_key,
  created_at,
  updated_at,
  last_run_at,
  last_run_status,
  last_error_message
)
SELECT
  task_id,
  title,
  instructions,
  schedule_kind,
  once_at,
  cron_expr,
  NULL AS rrule_expr,
  timezone,
  enabled,
  next_run_at,
  creator_thread_key,
  owner_user_key,
  delivery_target,
  execution_thread_key,
  created_at,
  updated_at,
  last_run_at,
  last_run_status,
  last_error_message
FROM scheduled_tasks_pre_rrule;

DROP TABLE scheduled_tasks_pre_rrule;

CREATE INDEX IF NOT EXISTS scheduled_tasks_due_idx ON scheduled_tasks (enabled, next_run_at);
CREATE INDEX IF NOT EXISTS scheduled_tasks_execution_thread_idx ON scheduled_tasks (execution_thread_key);

CREATE TABLE scheduled_task_runs (
  task_run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES scheduled_tasks(task_id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'succeeded', 'failed')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(task_id, scheduled_for),
  UNIQUE(idempotency_key)
);

INSERT INTO scheduled_task_runs (
  task_run_id,
  task_id,
  scheduled_for,
  idempotency_key,
  run_id,
  status,
  error_message,
  created_at,
  updated_at
)
SELECT
  task_run_id,
  task_id,
  scheduled_for,
  idempotency_key,
  run_id,
  status,
  error_message,
  created_at,
  updated_at
FROM scheduled_task_runs_backup;

DROP TABLE scheduled_task_runs_backup;

CREATE INDEX IF NOT EXISTS scheduled_task_runs_status_idx ON scheduled_task_runs (status, created_at);
