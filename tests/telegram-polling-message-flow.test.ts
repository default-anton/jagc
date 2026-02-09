import { describe, expect, test, vi } from 'vitest';

import type { RunService } from '../src/server/service.js';
import type { MessageIngest, RunRecord } from '../src/shared/run-types.js';
import {
  telegramTestChatId as testChatId,
  telegramTestUserId as testUserId,
  withTelegramAdapter,
} from './helpers/telegram-test-kit.js';

describe('TelegramPollingAdapter message flow integration', () => {
  test('ingests plain text as followUp and replies with run text output', async () => {
    const runService = new StubRunService('run-follow-up', [
      runRecord({
        runId: 'run-follow-up',
        status: 'succeeded',
        output: { text: 'Hello from run' },
      }),
    ]);

    await withTelegramAdapter({ runService: runService.asRunService() }, async ({ clone }) => {
      const updateId = clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: 'hello adapter',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage', (call) => call.payload.text === 'Hello from run');
      expect(sendMessage.payload.text).toBe('Hello from run');

      expect(runService.ingests).toEqual([
        {
          source: 'telegram',
          threadKey: 'telegram:chat:101',
          userKey: 'telegram:user:202',
          text: 'hello adapter',
          deliveryMode: 'followUp',
          idempotencyKey: `telegram:update:${updateId}`,
        },
      ]);
    });
  });

  test('steer command ingests with steer delivery mode', async () => {
    const runService = new StubRunService('run-steer', [
      runRecord({
        runId: 'run-steer',
        status: 'succeeded',
        output: { text: 'Steer done' },
      }),
    ]);

    await withTelegramAdapter({ runService: runService.asRunService() }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/steer interrupt this run',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage', (call) => call.payload.text === 'Steer done');
      expect(sendMessage.payload.text).toBe('Steer done');

      expect(runService.ingests).toHaveLength(1);
      expect(runService.ingests[0]).toMatchObject({
        source: 'telegram',
        threadKey: 'telegram:chat:101',
        userKey: 'telegram:user:202',
        text: 'interrupt this run',
        deliveryMode: 'steer',
      });
    });
  });

  test('empty steer message is rejected without ingesting a run', async () => {
    const runService = new StubRunService('run-unused', [
      runRecord({
        runId: 'run-unused',
        status: 'succeeded',
        output: { text: 'unused' },
      }),
    ]);

    await withTelegramAdapter({ runService: runService.asRunService() }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/steer',
      });

      const sendMessage = await clone.waitForBotCall(
        'sendMessage',
        (call) => call.payload.text === 'Message is empty.',
      );
      expect(sendMessage.payload.text).toBe('Message is empty.');
      expect(runService.ingests).toHaveLength(0);
    });
  });

  test('failed runs are surfaced as user-facing errors', async () => {
    const runService = new StubRunService('run-failed', [
      runRecord({
        runId: 'run-failed',
        status: 'failed',
        errorMessage: 'run exploded',
      }),
    ]);

    await withTelegramAdapter({ runService: runService.asRunService() }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: 'trigger failure',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage', (call) => call.payload.text === '❌ run exploded');
      expect(sendMessage.payload.text).toBe('❌ run exploded');
    });
  });

  test('structured output without text falls back to pretty JSON', async () => {
    const runService = new StubRunService('run-structured', [
      runRecord({
        runId: 'run-structured',
        status: 'succeeded',
        output: {
          blocks: ['hello', 'world'],
          usage: {
            tokens: 42,
          },
        },
      }),
    ]);

    await withTelegramAdapter({ runService: runService.asRunService() }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: 'structured output please',
      });

      const sendMessage = await clone.waitForBotCall(
        'sendMessage',
        (call) => typeof call.payload.text === 'string' && call.payload.text.startsWith('Run output:\n{'),
      );

      expect(sendMessage.payload.text).toContain('"blocks"');
      expect(sendMessage.payload.text).toContain('"tokens": 42');
    });
  });

  test('run wait timeout returns queued status message', async () => {
    const running = runRecord({
      runId: 'run-timeout',
      status: 'running',
      output: null,
      errorMessage: null,
    });
    const runService = new StubRunService('run-timeout', [running]);

    await withTelegramAdapter(
      {
        runService: runService.asRunService(),
        waitTimeoutMs: 25,
        pollIntervalMs: 5,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'still running?',
        });

        const sendMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === 'Run queued as run-timeout. Still running.',
        );
        expect(sendMessage.payload.text).toBe('Run queued as run-timeout. Still running.');
      },
    );
  });

  test('long text output is chunked into Telegram-sized messages', async () => {
    const longText = 'x'.repeat(3601);
    const runService = new StubRunService('run-long', [
      runRecord({
        runId: 'run-long',
        status: 'succeeded',
        output: { text: longText },
      }),
    ]);

    await withTelegramAdapter({ runService: runService.asRunService() }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: 'chunk it',
      });

      await clone.waitForBotCall(
        'sendMessage',
        (call) => typeof call.payload.text === 'string' && call.payload.text.length === 101,
      );

      const chunks = clone
        .getBotCalls()
        .filter((call) => call.method === 'sendMessage')
        .map((call) => call.payload.text)
        .filter((text): text is string => typeof text === 'string');

      expect(chunks).toHaveLength(2);
      expect(chunks.map((chunk) => chunk.length)).toEqual([3500, 101]);
      expect(chunks.join('')).toBe(longText);
    });
  });

  test('recovers from transient getUpdates 500 errors and still processes messages', async () => {
    const runService = new StubRunService('run-retry', [
      runRecord({
        runId: 'run-retry',
        status: 'succeeded',
        output: { text: 'Recovered after poll errors' },
      }),
    ]);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await withTelegramAdapter({ runService: runService.asRunService() }, async ({ clone }) => {
        clone.failNextApiCall(
          'getUpdates',
          {
            errorCode: 500,
            description: 'Internal Server Error',
          },
          2,
        );

        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'resilience check',
        });

        const sendMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === 'Recovered after poll errors',
          8_000,
        );

        expect(sendMessage.payload.text).toBe('Recovered after poll errors');
        expect(runService.ingests).toHaveLength(1);
        expect(clone.getApiCallCount('getUpdates')).toBeGreaterThanOrEqual(3);
      });
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  test('recovers from transient getUpdates 429 retry_after and still processes messages', async () => {
    const runService = new StubRunService('run-retry-after', [
      runRecord({
        runId: 'run-retry-after',
        status: 'succeeded',
        output: { text: 'Recovered after rate limit' },
      }),
    ]);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await withTelegramAdapter({ runService: runService.asRunService() }, async ({ clone }) => {
        clone.failNextApiCall('getUpdates', {
          errorCode: 429,
          description: 'Too Many Requests: retry later',
          parameters: {
            retry_after: 0.05,
          },
        });

        const startedAt = Date.now();

        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'retry after check',
        });

        const sendMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === 'Recovered after rate limit',
          8_000,
        );

        const elapsedMs = Date.now() - startedAt;
        expect(sendMessage.payload.text).toBe('Recovered after rate limit');
        expect(runService.ingests).toHaveLength(1);
        expect(elapsedMs).toBeGreaterThanOrEqual(120);
        expect(clone.getApiCallCount('getUpdates')).toBeGreaterThanOrEqual(2);
      });
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

class StubRunService {
  readonly ingests: MessageIngest[] = [];
  private pollCount = 0;

  constructor(
    private readonly runId: string,
    private readonly runStates: RunRecord[],
  ) {}

  asRunService(): RunService {
    return {
      ingestMessage: async (message: MessageIngest) => {
        this.ingests.push(message);

        const initialRun = this.runStates[0];
        if (!initialRun) {
          throw new Error('stub run service has no run states configured');
        }

        return {
          deduplicated: false,
          run: initialRun,
        };
      },
      getRun: async (runId: string) => {
        if (runId !== this.runId) {
          return null;
        }

        const stateIndex = Math.min(this.pollCount, this.runStates.length - 1);
        this.pollCount += 1;
        return this.runStates[stateIndex] ?? null;
      },
    } as unknown as RunService;
  }
}

function runRecord(overrides: Partial<RunRecord> & Pick<RunRecord, 'runId' | 'status'>): RunRecord {
  const timestamp = new Date(0).toISOString();
  const { runId, status, ...rest } = overrides;

  return {
    runId,
    source: 'telegram',
    threadKey: 'telegram:chat:101',
    userKey: 'telegram:user:202',
    deliveryMode: 'followUp',
    status,
    inputText: 'input',
    output: null,
    errorMessage: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...rest,
  };
}
