import { randomUUID } from 'node:crypto';
import {
  mapTaskRow,
  mapTaskRunRow,
  type ScheduledTaskRow,
  type ScheduledTaskRunRow,
} from './scheduled-task-store-mappers.js';
import type {
  CreateScheduledTaskInput,
  ListScheduledTasksFilter,
  ScheduledTaskDeliveryTarget,
  ScheduledTaskRecord,
  ScheduledTaskRunRecord,
  ScheduledTaskRunStatus,
  UpdateScheduledTaskInput,
} from './scheduled-task-types.js';
import { isSqliteConstraintViolation, type SqliteDatabase } from './sqlite.js';

export interface ScheduledTaskStore {
  init(): Promise<void>;
  createTask(input: CreateScheduledTaskInput): Promise<ScheduledTaskRecord>;
  listTasks(filter?: ListScheduledTasksFilter): Promise<ScheduledTaskRecord[]>;
  getTask(taskId: string): Promise<ScheduledTaskRecord | null>;
  updateTask(taskId: string, patch: UpdateScheduledTaskInput): Promise<ScheduledTaskRecord | null>;
  deleteTask(taskId: string): Promise<boolean>;
  listDueTasks(nowIso: string, limit: number): Promise<ScheduledTaskRecord[]>;
  createOrGetTaskRun(taskId: string, scheduledFor: string, idempotencyKey: string): Promise<ScheduledTaskRunRecord>;
  getTaskRun(taskRunId: string): Promise<ScheduledTaskRunRecord | null>;
  getTaskRunByRunId(runId: string): Promise<ScheduledTaskRunRecord | null>;
  listTaskRunsByStatuses(statuses: ScheduledTaskRunStatus[], limit: number): Promise<ScheduledTaskRunRecord[]>;
  markTaskRunDispatched(taskRunId: string, runId: string): Promise<void>;
  markTaskRunTerminal(taskRunId: string, status: 'succeeded' | 'failed', errorMessage: string | null): Promise<void>;
  setTaskExecutionThread(
    taskId: string,
    executionThreadKey: string,
    deliveryTarget: ScheduledTaskDeliveryTarget,
  ): Promise<void>;
  clearTaskExecutionThread(taskId: string, deliveryTarget: ScheduledTaskDeliveryTarget): Promise<void>;
  advanceTaskAfterOccurrence(
    taskId: string,
    scheduledFor: string,
    enabled: boolean,
    nextRunAt: string | null,
  ): Promise<void>;
}

export class SqliteScheduledTaskStore implements ScheduledTaskStore {
  constructor(private readonly database: SqliteDatabase) {}

  async init(): Promise<void> {}

  async createTask(input: CreateScheduledTaskInput): Promise<ScheduledTaskRecord> {
    const now = nowIsoTimestamp();
    const taskId = randomUUID();

    this.database
      .prepare(
        `
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)
        `,
      )
      .run(
        taskId,
        input.title,
        input.instructions,
        input.scheduleKind,
        input.onceAt,
        input.cronExpr,
        input.rruleExpr,
        input.timezone,
        input.enabled ? 1 : 0,
        input.nextRunAt,
        input.creatorThreadKey,
        input.ownerUserKey,
        JSON.stringify(input.deliveryTarget),
        now,
        now,
      );

    const created = this.getTaskById(taskId);
    if (!created) {
      throw new Error(`task ${taskId} was inserted but could not be loaded`);
    }

    return created;
  }

  async listTasks(filter: ListScheduledTasksFilter = {}): Promise<ScheduledTaskRecord[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.creatorThreadKey) {
      clauses.push('creator_thread_key = ?');
      params.push(filter.creatorThreadKey);
    }

    if (typeof filter.enabled === 'boolean') {
      clauses.push('enabled = ?');
      params.push(filter.enabled ? 1 : 0);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database
      .prepare<unknown[], ScheduledTaskRow>(
        `
          SELECT *
          FROM scheduled_tasks
          ${whereClause}
          ORDER BY created_at DESC
        `,
      )
      .all(...params);

    return rows.map(mapTaskRow);
  }

  async getTask(taskId: string): Promise<ScheduledTaskRecord | null> {
    return this.getTaskById(taskId);
  }

  async updateTask(taskId: string, patch: UpdateScheduledTaskInput): Promise<ScheduledTaskRecord | null> {
    const existing = this.getTaskById(taskId);
    if (!existing) {
      return null;
    }

    const nextValues = {
      title: patch.title ?? existing.title,
      instructions: patch.instructions ?? existing.instructions,
      scheduleKind: patch.scheduleKind ?? existing.scheduleKind,
      onceAt: patch.onceAt === undefined ? existing.onceAt : patch.onceAt,
      cronExpr: patch.cronExpr === undefined ? existing.cronExpr : patch.cronExpr,
      rruleExpr: patch.rruleExpr === undefined ? existing.rruleExpr : patch.rruleExpr,
      timezone: patch.timezone ?? existing.timezone,
      enabled: patch.enabled ?? existing.enabled,
      nextRunAt: patch.nextRunAt === undefined ? existing.nextRunAt : patch.nextRunAt,
    };

    this.database
      .prepare(
        `
          UPDATE scheduled_tasks
          SET title = ?,
              instructions = ?,
              schedule_kind = ?,
              once_at = ?,
              cron_expr = ?,
              rrule_expr = ?,
              timezone = ?,
              enabled = ?,
              next_run_at = ?,
              updated_at = ?
          WHERE task_id = ?
        `,
      )
      .run(
        nextValues.title,
        nextValues.instructions,
        nextValues.scheduleKind,
        nextValues.onceAt,
        nextValues.cronExpr,
        nextValues.rruleExpr,
        nextValues.timezone,
        nextValues.enabled ? 1 : 0,
        nextValues.nextRunAt,
        nowIsoTimestamp(),
        taskId,
      );

    return this.getTaskById(taskId);
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const result = this.database.prepare('DELETE FROM scheduled_tasks WHERE task_id = ?').run(taskId);
    return result.changes > 0;
  }

  async listDueTasks(nowIso: string, limit: number): Promise<ScheduledTaskRecord[]> {
    const rows = this.database
      .prepare<unknown[], ScheduledTaskRow>(
        `
          SELECT *
          FROM scheduled_tasks
          WHERE enabled = 1
            AND next_run_at IS NOT NULL
            AND next_run_at <= ?
          ORDER BY next_run_at ASC
          LIMIT ?
        `,
      )
      .all(nowIso, limit);

    return rows.map(mapTaskRow);
  }

  async createOrGetTaskRun(
    taskId: string,
    scheduledFor: string,
    idempotencyKey: string,
  ): Promise<ScheduledTaskRunRecord> {
    const createOrGet = this.database.transaction(
      (inputTaskId: string, inputScheduledFor: string, inputIdempotencyKey: string): ScheduledTaskRunRecord => {
        const existing = this.getTaskRunByTaskAndScheduledFor(inputTaskId, inputScheduledFor);
        if (existing) {
          return existing;
        }

        const taskRunId = randomUUID();
        const now = nowIsoTimestamp();
        this.database
          .prepare(
            `
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
              VALUES (?, ?, ?, ?, NULL, 'pending', NULL, ?, ?)
            `,
          )
          .run(taskRunId, inputTaskId, inputScheduledFor, inputIdempotencyKey, now, now);

        const created = this.getTaskRunById(taskRunId);
        if (!created) {
          throw new Error(`task run ${taskRunId} was inserted but could not be loaded`);
        }

        return created;
      },
    );

    try {
      return createOrGet(taskId, scheduledFor, idempotencyKey);
    } catch (error) {
      if (isSqliteConstraintViolation(error)) {
        const existing = this.getTaskRunByTaskAndScheduledFor(taskId, scheduledFor);
        if (existing) {
          return existing;
        }
      }

      throw error;
    }
  }

  async getTaskRun(taskRunId: string): Promise<ScheduledTaskRunRecord | null> {
    return this.getTaskRunById(taskRunId);
  }

  async getTaskRunByRunId(runId: string): Promise<ScheduledTaskRunRecord | null> {
    const row = this.database
      .prepare<unknown[], ScheduledTaskRunRow>('SELECT * FROM scheduled_task_runs WHERE run_id = ?')
      .get(runId);

    return row ? mapTaskRunRow(row) : null;
  }

  async listTaskRunsByStatuses(statuses: ScheduledTaskRunStatus[], limit: number): Promise<ScheduledTaskRunRecord[]> {
    if (statuses.length === 0) {
      return [];
    }

    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.database
      .prepare<unknown[], ScheduledTaskRunRow>(
        `
          SELECT *
          FROM scheduled_task_runs
          WHERE status IN (${placeholders})
          ORDER BY created_at ASC
          LIMIT ?
        `,
      )
      .all(...statuses, limit);

    return rows.map(mapTaskRunRow);
  }

  async markTaskRunDispatched(taskRunId: string, runId: string): Promise<void> {
    const result = this.database
      .prepare(
        `
          UPDATE scheduled_task_runs
          SET run_id = ?,
              status = 'dispatched',
              error_message = NULL,
              updated_at = ?
          WHERE task_run_id = ?
            AND status = 'pending'
        `,
      )
      .run(runId, nowIsoTimestamp(), taskRunId);

    if (result.changes !== 1) {
      const existing = this.getTaskRunById(taskRunId);
      if (!existing) {
        throw new Error(`cannot mark task run ${taskRunId} as dispatched: task run not found`);
      }

      if (existing.status === 'dispatched' && existing.runId === runId) {
        return;
      }

      throw new Error(`cannot mark task run ${taskRunId} as dispatched: status is ${existing.status}`);
    }
  }

  async markTaskRunTerminal(
    taskRunId: string,
    status: 'succeeded' | 'failed',
    errorMessage: string | null,
  ): Promise<void> {
    const mark = this.database.transaction(
      (inputTaskRunId: string, inputStatus: 'succeeded' | 'failed', message: string | null) => {
        const taskRun = this.getTaskRunById(inputTaskRunId);
        if (!taskRun) {
          throw new Error(`cannot mark task run ${inputTaskRunId} as ${inputStatus}: task run not found`);
        }

        if (taskRun.status === inputStatus) {
          return;
        }

        if (taskRun.status !== 'dispatched' && taskRun.status !== 'pending') {
          throw new Error(`cannot mark task run ${inputTaskRunId} as ${inputStatus}: status is ${taskRun.status}`);
        }

        const now = nowIsoTimestamp();
        this.database
          .prepare(
            `
            UPDATE scheduled_task_runs
            SET status = ?,
                error_message = ?,
                updated_at = ?
            WHERE task_run_id = ?
          `,
          )
          .run(inputStatus, message, now, inputTaskRunId);

        this.database
          .prepare(
            `
            UPDATE scheduled_tasks
            SET last_run_at = ?,
                last_run_status = ?,
                last_error_message = ?,
                updated_at = ?
            WHERE task_id = ?
          `,
          )
          .run(now, inputStatus, inputStatus === 'failed' ? message : null, now, taskRun.taskId);
      },
    );

    mark(taskRunId, status, errorMessage);
  }

  async setTaskExecutionThread(
    taskId: string,
    executionThreadKey: string,
    deliveryTarget: ScheduledTaskDeliveryTarget,
  ): Promise<void> {
    const result = this.database
      .prepare(
        `
          UPDATE scheduled_tasks
          SET execution_thread_key = ?,
              delivery_target = ?,
              updated_at = ?
          WHERE task_id = ?
        `,
      )
      .run(executionThreadKey, JSON.stringify(deliveryTarget), nowIsoTimestamp(), taskId);

    if (result.changes !== 1) {
      throw new Error(`cannot set execution thread for task ${taskId}: task not found`);
    }
  }

  async clearTaskExecutionThread(taskId: string, deliveryTarget: ScheduledTaskDeliveryTarget): Promise<void> {
    const result = this.database
      .prepare(
        `
          UPDATE scheduled_tasks
          SET execution_thread_key = NULL,
              delivery_target = ?,
              updated_at = ?
          WHERE task_id = ?
        `,
      )
      .run(JSON.stringify(deliveryTarget), nowIsoTimestamp(), taskId);

    if (result.changes !== 1) {
      throw new Error(`cannot clear execution thread for task ${taskId}: task not found`);
    }
  }

  async advanceTaskAfterOccurrence(
    taskId: string,
    scheduledFor: string,
    enabled: boolean,
    nextRunAt: string | null,
  ): Promise<void> {
    this.database
      .prepare(
        `
          UPDATE scheduled_tasks
          SET enabled = ?,
              next_run_at = ?,
              updated_at = ?
          WHERE task_id = ?
            AND next_run_at = ?
        `,
      )
      .run(enabled ? 1 : 0, nextRunAt, nowIsoTimestamp(), taskId, scheduledFor);
  }

  private getTaskById(taskId: string): ScheduledTaskRecord | null {
    const row = this.database
      .prepare<unknown[], ScheduledTaskRow>('SELECT * FROM scheduled_tasks WHERE task_id = ?')
      .get(taskId);
    return row ? mapTaskRow(row) : null;
  }

  private getTaskRunById(taskRunId: string): ScheduledTaskRunRecord | null {
    const row = this.database
      .prepare<unknown[], ScheduledTaskRunRow>('SELECT * FROM scheduled_task_runs WHERE task_run_id = ?')
      .get(taskRunId);

    return row ? mapTaskRunRow(row) : null;
  }

  private getTaskRunByTaskAndScheduledFor(taskId: string, scheduledFor: string): ScheduledTaskRunRecord | null {
    const row = this.database
      .prepare<unknown[], ScheduledTaskRunRow>(
        'SELECT * FROM scheduled_task_runs WHERE task_id = ? AND scheduled_for = ?',
      )
      .get(taskId, scheduledFor);

    return row ? mapTaskRunRow(row) : null;
  }
}

function nowIsoTimestamp(): string {
  return new Date().toISOString();
}
