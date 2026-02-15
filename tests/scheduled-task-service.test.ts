import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, test } from 'vitest';

import { ScheduledTaskService } from '../src/server/scheduled-task-service.js';
import { SqliteScheduledTaskStore } from '../src/server/scheduled-task-store.js';
import type { RunService } from '../src/server/service.js';
import type { MessageIngest, RunRecord } from '../src/shared/run-types.js';
import { useSqliteTestDb } from './helpers/sqlite-test-db.js';

const testDb = useSqliteTestDb();

describe('ScheduledTaskService', () => {
  test('due one-off task dispatches once and disables task', async () => {
    const store = new SqliteScheduledTaskStore(testDb.database);
    await store.init();

    const task = await store.createTask({
      title: 'One-off check',
      instructions: 'Run once',
      scheduleKind: 'once',
      onceAt: '2026-02-15T00:00:00.000Z',
      cronExpr: null,
      timezone: 'UTC',
      enabled: true,
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      creatorThreadKey: 'cli:default',
      ownerUserKey: null,
      deliveryTarget: { provider: 'cli', route: { threadKey: 'cli:default' } },
    });

    await store.setTaskExecutionThread(task.taskId, `cli:task:${task.taskId}`, task.deliveryTarget);

    const runService = new FakeRunService();
    const service = new ScheduledTaskService(store, runService.asRunService(), {
      pollIntervalMs: 20,
    });

    await service.start();
    await waitUntil(async () => runService.ingests.length === 1);
    await waitUntil(async () => {
      const taskRuns = await store.listTaskRunsByStatuses(['succeeded'], 10);
      return taskRuns.length === 1;
    });

    const updated = await store.getTask(task.taskId);
    expect(updated).not.toBeNull();
    expect(updated?.enabled).toBe(false);
    expect(updated?.nextRunAt).toBeNull();

    await service.stop();
  });

  test('due cron task advances next_run_at to a future slot', async () => {
    const store = new SqliteScheduledTaskStore(testDb.database);
    await store.init();

    const task = await store.createTask({
      title: 'Cron check',
      instructions: 'Run repeatedly',
      scheduleKind: 'cron',
      onceAt: null,
      cronExpr: '*/5 * * * *',
      timezone: 'UTC',
      enabled: true,
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      creatorThreadKey: 'cli:default',
      ownerUserKey: null,
      deliveryTarget: { provider: 'cli', route: { threadKey: 'cli:default' } },
    });

    await store.setTaskExecutionThread(task.taskId, `cli:task:${task.taskId}`, task.deliveryTarget);

    const runService = new FakeRunService();
    const service = new ScheduledTaskService(store, runService.asRunService(), {
      pollIntervalMs: 20,
    });

    await service.start();
    await waitUntil(async () => runService.ingests.length === 1);

    const updated = await store.getTask(task.taskId);
    expect(updated).not.toBeNull();
    expect(updated?.nextRunAt).not.toBeNull();
    expect(new Date(updated?.nextRunAt ?? 0).getTime()).toBeGreaterThan(Date.now());

    await service.stop();
  });

  test('run-now records failed occurrence when execution thread creation fails', async () => {
    const store = new SqliteScheduledTaskStore(testDb.database);
    await store.init();

    const task = await store.createTask({
      title: 'Telegram task',
      instructions: 'Run now',
      scheduleKind: 'cron',
      onceAt: null,
      cronExpr: '*/5 * * * *',
      timezone: 'UTC',
      enabled: true,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      creatorThreadKey: 'telegram:chat:101',
      ownerUserKey: null,
      deliveryTarget: {
        provider: 'telegram',
        route: {
          chatId: 101,
        },
      },
    });

    const service = new ScheduledTaskService(store, new FakeRunService().asRunService());

    await expect(service.runNow(task.taskId)).rejects.toThrow(/telegram_topics_unavailable/u);

    const failedRuns = await store.listTaskRunsByStatuses(['failed'], 10);
    expect(failedRuns).toHaveLength(1);
    expect(failedRuns[0]?.taskId).toBe(task.taskId);
    expect(failedRuns[0]?.errorMessage).toMatch(/telegram_topics_unavailable/u);
  });

  test('recovery resumes pending and dispatched task runs after restart', async () => {
    const store = new SqliteScheduledTaskStore(testDb.database);
    await store.init();

    const pendingTask = await store.createTask({
      title: 'Pending recovery',
      instructions: 'Recover pending run',
      scheduleKind: 'cron',
      onceAt: null,
      cronExpr: '*/10 * * * *',
      timezone: 'UTC',
      enabled: true,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      creatorThreadKey: 'cli:default',
      ownerUserKey: null,
      deliveryTarget: { provider: 'cli', route: { threadKey: 'cli:default' } },
    });

    await store.setTaskExecutionThread(
      pendingTask.taskId,
      `cli:task:${pendingTask.taskId}`,
      pendingTask.deliveryTarget,
    );

    const pendingRun = await store.createOrGetTaskRun(
      pendingTask.taskId,
      new Date(Date.now() - 5_000).toISOString(),
      `task:${pendingTask.taskId}:pending`,
    );

    const dispatchedTask = await store.createTask({
      title: 'Dispatched recovery',
      instructions: 'Recover dispatched run',
      scheduleKind: 'cron',
      onceAt: null,
      cronExpr: '*/10 * * * *',
      timezone: 'UTC',
      enabled: true,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      creatorThreadKey: 'cli:default',
      ownerUserKey: null,
      deliveryTarget: { provider: 'cli', route: { threadKey: 'cli:default' } },
    });

    await store.setTaskExecutionThread(
      dispatchedTask.taskId,
      `cli:task:${dispatchedTask.taskId}`,
      dispatchedTask.deliveryTarget,
    );

    const dispatchedRun = await store.createOrGetTaskRun(
      dispatchedTask.taskId,
      new Date(Date.now() - 4_000).toISOString(),
      `task:${dispatchedTask.taskId}:dispatched`,
    );

    await store.markTaskRunDispatched(dispatchedRun.taskRunId, 'run-existing-dispatched');

    const runService = new FakeRunService();
    runService.registerExistingRun('run-existing-dispatched', 'succeeded');

    const service = new ScheduledTaskService(store, runService.asRunService(), {
      pollIntervalMs: 20,
    });

    await service.start();
    await waitUntil(async () => {
      const succeeded = await store.listTaskRunsByStatuses(['succeeded'], 20);
      const pendingRecovered = succeeded.some((taskRun) => taskRun.taskRunId === pendingRun.taskRunId);
      const dispatchedRecovered = succeeded.some((taskRun) => taskRun.taskRunId === dispatchedRun.taskRunId);
      return pendingRecovered && dispatchedRecovered;
    });

    expect(runService.ingests.length).toBe(1);

    await service.stop();
  });
});

class FakeRunService {
  readonly ingests: MessageIngest[] = [];
  private nextRunSequence = 1;
  private readonly runs = new Map<string, RunRecord>();

  asRunService(): RunService {
    return {
      ingestMessage: async (message: MessageIngest) => {
        this.ingests.push(message);
        const runId = `run-${this.nextRunSequence++}`;
        const run = createRunRecord(runId, message, 'running');
        this.runs.set(runId, {
          ...run,
          status: 'succeeded',
          output: {
            text: 'ok',
          },
        });

        return {
          deduplicated: false,
          run,
        };
      },
      getRun: async (runId: string) => this.runs.get(runId) ?? null,
    } as unknown as RunService;
  }

  registerExistingRun(runId: string, status: 'running' | 'succeeded' | 'failed'): void {
    this.runs.set(
      runId,
      createRunRecord(
        runId,
        {
          source: 'task:existing',
          threadKey: 'cli:task:existing',
          text: 'existing run',
          deliveryMode: 'followUp',
        },
        status,
      ),
    );
  }
}

function createRunRecord(runId: string, message: MessageIngest, status: 'running' | 'succeeded' | 'failed'): RunRecord {
  const now = new Date().toISOString();

  return {
    runId,
    source: message.source,
    threadKey: message.threadKey,
    userKey: message.userKey ?? null,
    deliveryMode: message.deliveryMode,
    status,
    inputText: message.text,
    output: status === 'succeeded' ? { text: 'ok' } : null,
    errorMessage: status === 'failed' ? 'boom' : null,
    createdAt: now,
    updatedAt: now,
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();

  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }

    await sleep(20);
  }
}
