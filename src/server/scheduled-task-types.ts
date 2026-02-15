export type ScheduledTaskScheduleKind = 'once' | 'cron';
export type ScheduledTaskRunStatus = 'pending' | 'dispatched' | 'succeeded' | 'failed';

export interface ScheduledTaskDeliveryTarget {
  provider: string;
  route?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ScheduledTaskRecord {
  taskId: string;
  title: string;
  instructions: string;
  scheduleKind: ScheduledTaskScheduleKind;
  onceAt: string | null;
  cronExpr: string | null;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  creatorThreadKey: string;
  ownerUserKey: string | null;
  deliveryTarget: ScheduledTaskDeliveryTarget;
  executionThreadKey: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: 'succeeded' | 'failed' | null;
  lastErrorMessage: string | null;
}

export interface ScheduledTaskRunRecord {
  taskRunId: string;
  taskId: string;
  scheduledFor: string;
  idempotencyKey: string;
  runId: string | null;
  status: ScheduledTaskRunStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledTaskInput {
  title: string;
  instructions: string;
  scheduleKind: ScheduledTaskScheduleKind;
  onceAt: string | null;
  cronExpr: string | null;
  timezone: string;
  creatorThreadKey: string;
  ownerUserKey: string | null;
  deliveryTarget: ScheduledTaskDeliveryTarget;
  enabled: boolean;
  nextRunAt: string | null;
}

export interface UpdateScheduledTaskInput {
  title?: string;
  instructions?: string;
  scheduleKind?: ScheduledTaskScheduleKind;
  onceAt?: string | null;
  cronExpr?: string | null;
  timezone?: string;
  enabled?: boolean;
  nextRunAt?: string | null;
}

export interface ListScheduledTasksFilter {
  creatorThreadKey?: string;
  enabled?: boolean;
}
