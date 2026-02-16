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
      rruleExpr: null,
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
      rruleExpr: null,
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

  test('createTask supports rrule schedules and normalizes expression', async () => {
    const store = new SqliteScheduledTaskStore(testDb.database);
    await store.init();

    const service = new ScheduledTaskService(store, new FakeRunService().asRunService());

    const created = await service.createTask({
      creatorThreadKey: 'cli:default',
      title: 'First Monday planning',
      instructions: 'Prepare monthly priorities',
      schedule: {
        kind: 'rrule',
        rruleExpr: 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0',
        timezone: 'UTC',
      },
    });

    expect(created.scheduleKind).toBe('rrule');
    expect(created.rruleExpr).toContain('DTSTART;TZID=UTC:');
    expect(created.rruleExpr).toContain('RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0');
    expect(created.nextRunAt).toEqual(expect.any(String));
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
      rruleExpr: null,
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

  test('run-now always creates a dedicated task topic even when task was created from a creator topic', async () => {
    const store = new SqliteScheduledTaskStore(testDb.database);
    await store.init();

    const task = await store.createTask({
      title: 'Telegram dedicated topic',
      instructions: 'Run now in task-specific topic',
      scheduleKind: 'once',
      onceAt: new Date(Date.now() + 60_000).toISOString(),
      cronExpr: null,
      rruleExpr: null,
      timezone: 'UTC',
      enabled: true,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      creatorThreadKey: 'telegram:chat:101:topic:333',
      ownerUserKey: null,
      deliveryTarget: {
        provider: 'telegram',
        route: {
          chatId: 101,
        },
        metadata: {
          creatorMessageThreadId: 333,
        },
      },
    });

    const runService = new FakeRunService();
    const deliverCalls: Array<{ runId: string; route: { chatId: number; messageThreadId?: number } }> = [];
    const createTopicCalls: Array<{ chatId: number; taskId: string; title: string }> = [];

    const service = new ScheduledTaskService(store, runService.asRunService(), {
      telegramBridge: {
        createTaskTopic: async ({ chatId, taskId, title }) => {
          createTopicCalls.push({ chatId, taskId, title });
          return {
            chatId,
            messageThreadId: 777,
          };
        },
        syncTaskTopicTitle: async () => {},
        deliverRun: async (runId, route) => {
          deliverCalls.push({ runId, route });
        },
      },
    });

    const result = await service.runNow(task.taskId);
    expect(result).not.toBeNull();
    expect(createTopicCalls).toEqual([
      {
        chatId: 101,
        taskId: task.taskId,
        title: 'Telegram dedicated topic',
      },
    ]);
    expect(result?.task.executionThreadKey).toBe('telegram:chat:101:topic:777');
    expect(result?.task.deliveryTarget.route).toMatchObject({ chatId: 101, messageThreadId: 777 });
    expect(deliverCalls).toHaveLength(1);
    expect(deliverCalls[0]?.route).toEqual({ chatId: 101, messageThreadId: 777 });
  });

  test('update title does not rename creator topic for legacy tasks where execution thread matches creator topic id', async () => {
    const store = new SqliteScheduledTaskStore(testDb.database);
    await store.init();

    const deliveryTarget = {
      provider: 'telegram' as const,
      route: {
        chatId: 101,
        messageThreadId: 333,
      },
      metadata: {
        creatorMessageThreadId: 333,
      },
    };

    const task = await store.createTask({
      title: 'Original title',
      instructions: 'Keep creator topic intact',
      scheduleKind: 'once',
      onceAt: new Date(Date.now() + 60_000).toISOString(),
      cronExpr: null,
      rruleExpr: null,
      timezone: 'UTC',
      enabled: true,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      creatorThreadKey: 'telegram:chat:101:topic:333',
      ownerUserKey: null,
      deliveryTarget,
    });

    await store.setTaskExecutionThread(task.taskId, 'telegram:chat:101:topic:333', deliveryTarget);

    const syncCalls: Array<{ route: { chatId: number; messageThreadId?: number }; taskId: string; title: string }> = [];

    const service = new ScheduledTaskService(store, new FakeRunService().asRunService(), {
      telegramBridge: {
        createTaskTopic: async () => {
          throw new Error('createTaskTopic should not be called for title sync');
        },
        syncTaskTopicTitle: async (route, taskId, title) => {
          syncCalls.push({ route, taskId, title });
        },
        deliverRun: async () => {},
      },
    });

    const updated = await service.updateTask(task.taskId, { title: 'Renamed title' });
    expect(updated).not.toBeNull();
    expect(updated?.warnings).toEqual([]);
    expect(syncCalls).toEqual([]);
  });

  test('update title renames task-owned topic when execution topic is task-specific', async () => {
    const store = new SqliteScheduledTaskStore(testDb.database);
    await store.init();

    const deliveryTarget = {
      provider: 'telegram' as const,
      route: {
        chatId: 101,
        messageThreadId: 777,
      },
    };

    const task = await store.createTask({
      title: 'Task-owned topic title',
      instructions: 'Sync topic title',
      scheduleKind: 'once',
      onceAt: new Date(Date.now() + 60_000).toISOString(),
      cronExpr: null,
      rruleExpr: null,
      timezone: 'UTC',
      enabled: true,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      creatorThreadKey: 'telegram:chat:101',
      ownerUserKey: null,
      deliveryTarget,
    });

    await store.setTaskExecutionThread(task.taskId, 'telegram:chat:101:topic:777', deliveryTarget);

    const syncCalls: Array<{ route: { chatId: number; messageThreadId?: number }; taskId: string; title: string }> = [];

    const service = new ScheduledTaskService(store, new FakeRunService().asRunService(), {
      telegramBridge: {
        createTaskTopic: async () => {
          throw new Error('createTaskTopic should not be called for title sync');
        },
        syncTaskTopicTitle: async (route, taskId, title) => {
          syncCalls.push({ route, taskId, title });
        },
        deliverRun: async () => {},
      },
    });

    const updated = await service.updateTask(task.taskId, { title: 'Renamed owned topic title' });
    expect(updated).not.toBeNull();
    expect(updated?.warnings).toEqual([]);
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0]).toEqual({
      route: { chatId: 101, messageThreadId: 777 },
      taskId: task.taskId,
      title: 'Renamed owned topic title',
    });
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
      rruleExpr: null,
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
      rruleExpr: null,
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
