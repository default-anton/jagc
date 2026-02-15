import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import { TelegramPollingAdapter } from '../src/adapters/telegram-polling.js';
import { createApp } from '../src/server/app.js';
import { EchoRunExecutor } from '../src/server/executor.js';
import { ScheduledTaskService } from '../src/server/scheduled-task-service.js';
import { SqliteScheduledTaskStore } from '../src/server/scheduled-task-store.js';
import { LocalRunScheduler } from '../src/server/scheduler.js';
import { RunService } from '../src/server/service.js';
import type { SqliteDatabase } from '../src/server/sqlite.js';
import { SqliteRunStore } from '../src/server/store.js';
import { useSqliteTestDb } from './helpers/sqlite-test-db.js';
import { TelegramBotApiClone } from './helpers/telegram-bot-api-clone.js';
import { telegramTestBotToken, telegramTestChatId, telegramTestUserId } from './helpers/telegram-test-kit.js';

const testDb = useSqliteTestDb();

describe('Telegram system smoke', () => {
  const runningStacks = new Set<RunningTelegramSystemStack>();

  afterEach(async () => {
    for (const stack of [...runningStacks]) {
      await stack.stop();
      runningStacks.delete(stack);
    }
  });

  test('polling update flows through run ingestion, execution, persistence, and API retrieval', async () => {
    const stack = await startTelegramSystemStack(testDb.database);
    runningStacks.add(stack);

    const updateId = stack.clone.injectTextMessage({
      chatId: telegramTestChatId,
      fromId: telegramTestUserId,
      text: 'system smoke ping',
    });

    const botReply = await stack.clone.waitForBotCall(
      'sendMessage',
      (call) => call.payload.text === 'system smoke ping',
      5_000,
    );
    expect(botReply.payload.text).toBe('system smoke ping');

    const persistedRun = await loadRunByTelegramUpdateId(testDb.database, updateId);
    expect(persistedRun).toMatchObject({
      source: 'telegram',
      thread_key: 'telegram:chat:101',
      user_key: 'telegram:user:202',
      delivery_mode: 'followUp',
      status: 'succeeded',
      input_text: 'system smoke ping',
    });
    expect(persistedRun.output).toMatchObject({
      type: 'message',
      text: 'system smoke ping',
      delivery_mode: 'followUp',
    });

    const runResponse = await fetch(`${stack.apiBaseUrl}/v1/runs/${encodeURIComponent(persistedRun.run_id)}`);
    expect(runResponse.status).toBe(200);

    const runJson = (await runResponse.json()) as {
      run_id: string;
      status: string;
      output: Record<string, unknown> | null;
      error: { message: string } | null;
    };
    expect(runJson).toMatchObject({
      run_id: persistedRun.run_id,
      status: 'succeeded',
      error: null,
      output: {
        type: 'message',
        text: 'system smoke ping',
        delivery_mode: 'followUp',
      },
    });

    await stack.stop();
    runningStacks.delete(stack);
  });

  test('steer command persists steer delivery mode end-to-end', async () => {
    const stack = await startTelegramSystemStack(testDb.database);
    runningStacks.add(stack);

    const updateId = stack.clone.injectTextMessage({
      chatId: telegramTestChatId,
      fromId: telegramTestUserId,
      text: '/steer cut in now',
    });

    const botReply = await stack.clone.waitForBotCall(
      'sendMessage',
      (call) => call.payload.text === 'cut in now',
      5_000,
    );
    expect(botReply.payload.text).toBe('cut in now');

    const persistedRun = await loadRunByTelegramUpdateId(testDb.database, updateId);
    expect(persistedRun.delivery_mode).toBe('steer');
    expect(persistedRun.status).toBe('succeeded');
    expect(persistedRun.output).toMatchObject({
      text: 'cut in now',
      delivery_mode: 'steer',
    });

    await stack.stop();
    runningStacks.delete(stack);
  });

  test('run-now lazily creates a Telegram topic and delivers scheduled output in that topic thread', async () => {
    const stack = await startTelegramSystemStack(testDb.database);
    runningStacks.add(stack);

    const createTaskResponse = await fetch(
      `${stack.apiBaseUrl}/v1/threads/${encodeURIComponent('telegram:chat:101')}/tasks`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Daily plan',
          instructions: 'Prepare my day plan',
          schedule: {
            kind: 'cron',
            cron: '0 9 * * 1-5',
            timezone: 'America/Los_Angeles',
          },
        }),
      },
    );

    expect(createTaskResponse.status).toBe(201);
    const createdTask = (await createTaskResponse.json()) as { task: { task_id: string } };

    expect(stack.clone.getApiCallCount('createForumTopic')).toBe(0);

    const runNowResponse = await fetch(
      `${stack.apiBaseUrl}/v1/tasks/${encodeURIComponent(createdTask.task.task_id)}/run-now`,
      {
        method: 'POST',
      },
    );

    expect(runNowResponse.status).toBe(200);

    const createTopicCall = await stack.clone.waitForBotCall('createForumTopic', () => true, 5_000);
    expect(String(createTopicCall.payload.name)).toContain('task:');

    const topicReply = await stack.clone.waitForBotCall(
      'sendMessage',
      (call) =>
        typeof call.payload.message_thread_id === 'number' &&
        typeof call.payload.text === 'string' &&
        String(call.payload.text).includes('[SCHEDULED TASK]'),
      8_000,
    );

    expect(topicReply.payload.chat_id).toBe(telegramTestChatId);
    expect(typeof topicReply.payload.message_thread_id).toBe('number');

    const updatedTitle = 'Daily plan updated';
    const patchTaskResponse = await fetch(`${stack.apiBaseUrl}/v1/tasks/${encodeURIComponent(createdTask.task.task_id)}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: updatedTitle,
      }),
    });

    expect(patchTaskResponse.status).toBe(200);

    const editTopicCall = await stack.clone.waitForBotCall('editForumTopic', () => true, 5_000);
    expect(String(editTopicCall.payload.name)).toBe(`task:${createdTask.task.task_id.slice(0, 8)} ${updatedTitle}`);

    await stack.stop();
    runningStacks.delete(stack);
  }, 20_000);
});

interface PersistedRunRow {
  run_id: string;
  source: string;
  thread_key: string;
  user_key: string | null;
  delivery_mode: 'followUp' | 'steer';
  status: 'running' | 'succeeded' | 'failed';
  input_text: string;
  output: Record<string, unknown> | null;
}

interface PersistedRunRowRaw extends Omit<PersistedRunRow, 'output'> {
  output: string | null;
}

interface RunningTelegramSystemStack {
  clone: TelegramBotApiClone;
  app: FastifyInstance;
  runService: RunService;
  scheduledTaskService: ScheduledTaskService;
  apiBaseUrl: string;
  stop(): Promise<void>;
}

async function startTelegramSystemStack(database: SqliteDatabase): Promise<RunningTelegramSystemStack> {
  const clone = new TelegramBotApiClone({ token: telegramTestBotToken });
  let app: FastifyInstance | null = null;
  let runService: RunService | null = null;
  let scheduledTaskService: ScheduledTaskService | null = null;
  let adapter: TelegramPollingAdapter | null = null;

  try {
    await clone.start();

    const runStore = new SqliteRunStore(database);

    const runScheduler = new LocalRunScheduler({
      dispatchRunById: async (runId) => {
        if (!runService) {
          throw new Error('run service is not initialized');
        }

        await runService.dispatchRunById(runId);
      },
    });

    runService = new RunService(runStore, new EchoRunExecutor(5), runScheduler);
    await runService.init();

    adapter = new TelegramPollingAdapter({
      botToken: telegramTestBotToken,
      runService,
      allowedTelegramUserIds: [String(telegramTestUserId)],
      telegramApiRoot: clone.apiRoot ?? undefined,
      pollRequestTimeoutSeconds: 1,
      pollIntervalMs: 10,
    });
    await adapter.start();

    const scheduledTaskStore = new SqliteScheduledTaskStore(database);
    scheduledTaskService = new ScheduledTaskService(scheduledTaskStore, runService, {
      pollIntervalMs: 50,
      telegramBridge: {
        createTaskTopic: async ({ chatId, taskId, title }) => {
          if (!adapter) {
            throw new Error('telegram adapter not started');
          }

          return adapter.createTaskTopic({ chatId, taskId, title });
        },
        syncTaskTopicTitle: async (route, taskId, title) => {
          if (!adapter) {
            throw new Error('telegram adapter not started');
          }

          await adapter.syncTaskTopicTitle(route, taskId, title);
        },
        deliverRun: async (runId, route) => {
          if (!adapter) {
            throw new Error('telegram adapter not started');
          }

          await adapter.deliverRun(runId, route);
        },
      },
    });
    await scheduledTaskService.start();

    app = createApp({
      runService,
      scheduledTaskService,
    });

    await app.listen({
      host: '127.0.0.1',
      port: 0,
    });

    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('server did not bind to a TCP address');
    }

    let stopped = false;

    return {
      clone,
      app,
      runService,
      scheduledTaskService,
      apiBaseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
      async stop() {
        if (stopped) {
          return;
        }

        stopped = true;
        await stopTelegramSystemResources({ adapter, app, scheduledTaskService, runService, clone });
      },
    };
  } catch (error) {
    try {
      await stopTelegramSystemResources({ adapter, app, scheduledTaskService, runService, clone });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'failed to start telegram system stack');
    }

    throw error;
  }
}

async function stopTelegramSystemResources(resources: {
  adapter: TelegramPollingAdapter | null;
  app: FastifyInstance | null;
  scheduledTaskService: ScheduledTaskService | null;
  runService: RunService | null;
  clone: TelegramBotApiClone;
}): Promise<void> {
  const failures: unknown[] = [];

  if (resources.scheduledTaskService) {
    try {
      await resources.scheduledTaskService.stop();
    } catch (error) {
      failures.push(error);
    }
  }

  if (resources.adapter) {
    try {
      await resources.adapter.stop();
    } catch (error) {
      failures.push(error);
    }
  }

  if (resources.app) {
    try {
      await resources.app.close();
    } catch (error) {
      failures.push(error);
    }
  }

  if (resources.runService) {
    try {
      await resources.runService.shutdown();
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    await resources.clone.stop();
  } catch (error) {
    failures.push(error);
  }

  if (failures.length > 0) {
    throw failures[0];
  }
}

async function loadRunByTelegramUpdateId(database: SqliteDatabase, updateId: number): Promise<PersistedRunRow> {
  const idempotencyKey = `telegram:update:${updateId}`;

  const run = database
    .prepare<unknown[], PersistedRunRowRaw>(
      `
        SELECT r.run_id, r.source, r.thread_key, r.user_key, r.delivery_mode, r.status, r.input_text, r.output
        FROM message_ingest mi
        INNER JOIN runs r ON r.run_id = mi.run_id
        WHERE mi.source = ? AND mi.idempotency_key = ?
      `,
    )
    .get('telegram', idempotencyKey);

  if (!run) {
    throw new Error(`run not found for telegram idempotency key ${idempotencyKey}`);
  }

  return {
    ...run,
    output: parseRunOutput(run.output),
  };
}

function parseRunOutput(serialized: string | null): Record<string, unknown> | null {
  if (!serialized) {
    return null;
  }

  return JSON.parse(serialized) as Record<string, unknown>;
}
