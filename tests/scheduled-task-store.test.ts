import { describe, expect, test } from 'vitest';

import { SqliteScheduledTaskStore } from '../src/server/scheduled-task-store.js';
import { useSqliteTestDb } from './helpers/sqlite-test-db.js';

const testDb = useSqliteTestDb();

describe('SqliteScheduledTaskStore schema invariants', () => {
  test('creates scheduled task tables with required indexes', () => {
    const tables = testDb.database
      .prepare<unknown[], { name: string }>(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('scheduled_tasks', 'scheduled_task_runs')
          ORDER BY name
        `,
      )
      .all()
      .map((row) => row.name);

    expect(tables).toEqual(['scheduled_task_runs', 'scheduled_tasks']);

    const taskIndexes = testDb.database
      .prepare<unknown[], { name: string }>(`PRAGMA index_list('scheduled_tasks')`)
      .all()
      .map((row) => row.name);

    expect(taskIndexes).toEqual(
      expect.arrayContaining(['scheduled_tasks_due_idx', 'scheduled_tasks_execution_thread_idx']),
    );

    const taskRunIndexes = testDb.database
      .prepare<unknown[], { name: string }>(`PRAGMA index_list('scheduled_task_runs')`)
      .all()
      .map((row) => row.name);

    expect(taskRunIndexes).toEqual(expect.arrayContaining(['scheduled_task_runs_status_idx']));
  });

  test('supports schedule kind transitions during task updates', async () => {
    const store = new SqliteScheduledTaskStore(testDb.database);
    await store.init();

    const onceTask = await store.createTask({
      title: 'Once task',
      instructions: 'Run once',
      scheduleKind: 'once',
      onceAt: '2026-02-16T17:00:00.000Z',
      cronExpr: null,
      timezone: 'UTC',
      enabled: true,
      nextRunAt: '2026-02-16T17:00:00.000Z',
      creatorThreadKey: 'cli:default',
      ownerUserKey: null,
      deliveryTarget: {
        provider: 'cli',
        route: {
          threadKey: 'cli:default',
        },
      },
    });

    const transitionedToCron = await store.updateTask(onceTask.taskId, {
      scheduleKind: 'cron',
      onceAt: null,
      cronExpr: '0 9 * * 1-5',
    });

    expect(transitionedToCron).not.toBeNull();
    expect(transitionedToCron?.scheduleKind).toBe('cron');
    expect(transitionedToCron?.onceAt).toBeNull();
    expect(transitionedToCron?.cronExpr).toBe('0 9 * * 1-5');

    const cronTask = await store.createTask({
      title: 'Cron task',
      instructions: 'Run often',
      scheduleKind: 'cron',
      onceAt: null,
      cronExpr: '*/5 * * * *',
      timezone: 'UTC',
      enabled: true,
      nextRunAt: '2026-02-16T17:05:00.000Z',
      creatorThreadKey: 'cli:default',
      ownerUserKey: null,
      deliveryTarget: {
        provider: 'cli',
        route: {
          threadKey: 'cli:default',
        },
      },
    });

    const transitionedToOnce = await store.updateTask(cronTask.taskId, {
      scheduleKind: 'once',
      onceAt: '2026-02-17T09:00:00.000Z',
      cronExpr: null,
    });

    expect(transitionedToOnce).not.toBeNull();
    expect(transitionedToOnce?.scheduleKind).toBe('once');
    expect(transitionedToOnce?.onceAt).toBe('2026-02-17T09:00:00.000Z');
    expect(transitionedToOnce?.cronExpr).toBeNull();
  });

  test('enforces task run uniqueness by task occurrence and idempotency key', async () => {
    const store = new SqliteScheduledTaskStore(testDb.database);
    await store.init();

    const created = await store.createTask({
      title: 'Daily plan',
      instructions: 'Prepare daily plan',
      scheduleKind: 'cron',
      onceAt: null,
      cronExpr: '0 9 * * 1-5',
      timezone: 'America/Los_Angeles',
      enabled: true,
      nextRunAt: '2026-02-16T17:00:00.000Z',
      creatorThreadKey: 'cli:default',
      ownerUserKey: null,
      deliveryTarget: {
        provider: 'cli',
        route: {
          threadKey: 'cli:default',
        },
      },
    });

    const first = await store.createOrGetTaskRun(created.taskId, '2026-02-16T17:00:00.000Z', 'key-1');
    const second = await store.createOrGetTaskRun(created.taskId, '2026-02-16T17:00:00.000Z', 'key-1');

    expect(first.taskRunId).toBe(second.taskRunId);

    expect(() =>
      testDb.database
        .prepare(
          `
            INSERT INTO scheduled_task_runs (
              task_run_id,
              task_id,
              scheduled_for,
              idempotency_key,
              status,
              created_at,
              updated_at
            )
            VALUES ('dup-run', ?, '2026-02-16T17:00:00.000Z', 'key-2', 'pending', '2026-02-16T00:00:00.000Z', '2026-02-16T00:00:00.000Z')
          `,
        )
        .run(created.taskId),
    ).toThrow(/UNIQUE constraint failed: scheduled_task_runs.task_id, scheduled_task_runs.scheduled_for/u);

    expect(() =>
      testDb.database
        .prepare(
          `
            INSERT INTO scheduled_task_runs (
              task_run_id,
              task_id,
              scheduled_for,
              idempotency_key,
              status,
              created_at,
              updated_at
            )
            VALUES ('dup-idem', ?, '2026-02-17T17:00:00.000Z', 'key-1', 'pending', '2026-02-16T00:00:00.000Z', '2026-02-16T00:00:00.000Z')
          `,
        )
        .run(created.taskId),
    ).toThrow(/UNIQUE constraint failed: scheduled_task_runs.idempotency_key/u);
  });
});
