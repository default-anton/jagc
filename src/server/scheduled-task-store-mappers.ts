import type {
  ScheduledTaskDeliveryTarget,
  ScheduledTaskRecord,
  ScheduledTaskRunRecord,
  ScheduledTaskRunStatus,
} from './scheduled-task-types.js';

export interface ScheduledTaskRow {
  task_id: string;
  title: string;
  instructions: string;
  schedule_kind: 'once' | 'cron' | 'rrule';
  once_at: string | null;
  cron_expr: string | null;
  rrule_expr: string | null;
  timezone: string;
  enabled: number;
  next_run_at: string | null;
  creator_thread_key: string;
  owner_user_key: string | null;
  delivery_target: string;
  execution_thread_key: string | null;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  last_run_status: 'succeeded' | 'failed' | null;
  last_error_message: string | null;
}

export interface ScheduledTaskRunRow {
  task_run_id: string;
  task_id: string;
  scheduled_for: string;
  idempotency_key: string;
  run_id: string | null;
  status: ScheduledTaskRunStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export function mapTaskRow(row: ScheduledTaskRow): ScheduledTaskRecord {
  return {
    taskId: row.task_id,
    title: row.title,
    instructions: row.instructions,
    scheduleKind: row.schedule_kind,
    onceAt: row.once_at,
    cronExpr: row.cron_expr,
    rruleExpr: row.rrule_expr,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    creatorThreadKey: row.creator_thread_key,
    ownerUserKey: row.owner_user_key,
    deliveryTarget: parseDeliveryTarget(row.task_id, row.delivery_target),
    executionThreadKey: row.execution_thread_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    lastErrorMessage: row.last_error_message,
  };
}

export function mapTaskRunRow(row: ScheduledTaskRunRow): ScheduledTaskRunRecord {
  return {
    taskRunId: row.task_run_id,
    taskId: row.task_id,
    scheduledFor: row.scheduled_for,
    idempotencyKey: row.idempotency_key,
    runId: row.run_id,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseDeliveryTarget(taskId: string, serialized: string): ScheduledTaskDeliveryTarget {
  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      `failed to parse scheduled task ${taskId} delivery_target: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`scheduled task ${taskId} delivery_target must be a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.provider !== 'string' || record.provider.trim().length === 0) {
    throw new Error(`scheduled task ${taskId} delivery_target.provider must be a non-empty string`);
  }

  return {
    provider: record.provider,
    route: isRecord(record.route) ? record.route : undefined,
    metadata: isRecord(record.metadata) ? record.metadata : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
