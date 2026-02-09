import { describe, expect, test, vi } from 'vitest';

import type { RunService } from '../src/server/service.js';
import type { RunProgressEvent } from '../src/shared/run-progress.js';
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

  test('shows progress updates and typing indicator during long-running runs', async () => {
    const runningState = runRecord({
      runId: 'run-progress',
      status: 'running',
      output: null,
      errorMessage: null,
    });
    const completedState = runRecord({
      runId: 'run-progress',
      status: 'succeeded',
      output: { text: 'Progress done' },
      errorMessage: null,
    });

    const runService = new StubRunService(
      'run-progress',
      [
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        completedState,
      ],
      {
        progressEventsByPoll: {
          1: [progressEvent('run-progress', 'started')],
          2: [
            progressEvent('run-progress', 'tool_execution_start', {
              toolCallId: 'tool-1',
              toolName: 'bash',
              args: { command: 'pnpm test' },
            }),
          ],
          3: [
            progressEvent('run-progress', 'assistant_thinking_delta', {
              delta: 'Thinking about next step',
            }),
          ],
          4: [
            progressEvent('run-progress', 'assistant_text_delta', {
              delta: 'Draft progress output',
            }),
          ],
          5: [
            progressEvent('run-progress', 'tool_execution_end', {
              toolCallId: 'tool-1',
              toolName: 'bash',
              result: { ok: true },
              isError: false,
            }),
          ],
        },
      },
    );

    await withTelegramAdapter(
      {
        runService: runService.asRunService(),
        waitTimeoutMs: 4_000,
        pollIntervalMs: 200,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'show me progress',
        });

        const progressMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => typeof call.payload.text === 'string' && call.payload.text.includes('queued'),
          4_000,
        );
        expect(progressMessage.payload.text).toContain('queued');

        const typingCall = await clone.waitForBotCall('sendChatAction', () => true, 4_000);
        expect(typingCall.payload.action).toBe('typing');

        const progressEdit = await clone.waitForBotCall(
          'editMessageText',
          (call) =>
            typeof call.payload.text === 'string' &&
            call.payload.text.includes('> bash cmd="pnpm test"') &&
            call.payload.text.includes('~'),
          6_000,
        );
        expect(progressEdit.payload.text).toContain('> bash cmd="pnpm test"');
        expect(progressEdit.payload.text).toContain('~');
        expect(progressEdit.payload.text).not.toContain('Now:');
        expect(progressEdit.payload.text).not.toContain('Recent tool calls:');
        expect(progressEdit.payload.text).not.toContain('Thinking:');

        const finalMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === 'Progress done',
          6_000,
        );
        expect(finalMessage.payload.text).toBe('Progress done');
      },
    );
  }, 12_000);

  test('flushes latest thinking preview before tool events so snippets are not left mid-token', async () => {
    const runningState = runRecord({
      runId: 'run-thinking-flush',
      status: 'running',
      output: null,
      errorMessage: null,
    });
    const completedState = runRecord({
      runId: 'run-thinking-flush',
      status: 'succeeded',
      output: { text: 'Thinking flush done' },
      errorMessage: null,
    });

    const runService = new StubRunService(
      'run-thinking-flush',
      [
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        completedState,
      ],
      {
        progressEventsByPoll: {
          1: [progressEvent('run-thinking-flush', 'started')],
          2: [
            progressEvent('run-thinking-flush', 'assistant_thinking_delta', {
              delta: '**Listing',
            }),
          ],
          3: [
            progressEvent('run-thinking-flush', 'assistant_thinking_delta', {
              delta: ' directories',
            }),
          ],
          4: [
            progressEvent('run-thinking-flush', 'tool_execution_start', {
              toolCallId: 'tool-1',
              toolName: 'bash',
              args: { command: 'find . -maxdepth 1 -type d' },
            }),
          ],
          5: [
            progressEvent('run-thinking-flush', 'tool_execution_end', {
              toolCallId: 'tool-1',
              toolName: 'bash',
              result: { ok: true },
              isError: false,
            }),
          ],
        },
      },
    );

    await withTelegramAdapter(
      {
        runService: runService.asRunService(),
        waitTimeoutMs: 4_000,
        pollIntervalMs: 200,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'show latest thinking preview',
        });

        const progressEdit = await clone.waitForBotCall(
          'editMessageText',
          (call) =>
            typeof call.payload.text === 'string' &&
            call.payload.text.includes('> bash cmd="find . -maxdepth 1 -type d"'),
          8_000,
        );

        expect(progressEdit.payload.text).toContain('~ **Listing directories');
        expect(progressEdit.payload.text).toContain('> bash cmd="find . -maxdepth 1 -type d"');

        const finalMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === 'Thinking flush done',
          8_000,
        );
        expect(finalMessage.payload.text).toBe('Thinking flush done');
      },
    );
  }, 14_000);

  test('tool progress labels keep only useful argument snippets', async () => {
    const runningState = runRecord({
      runId: 'run-tool-snippets',
      status: 'running',
      output: null,
      errorMessage: null,
    });
    const completedState = runRecord({
      runId: 'run-tool-snippets',
      status: 'succeeded',
      output: { text: 'Tool snippets done' },
      errorMessage: null,
    });

    const longCommand = `echo ${'x'.repeat(220)}`;

    const runService = new StubRunService(
      'run-tool-snippets',
      [
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        completedState,
      ],
      {
        progressEventsByPoll: {
          1: [progressEvent('run-tool-snippets', 'started')],
          2: [
            progressEvent('run-tool-snippets', 'tool_execution_start', {
              toolCallId: 'read-1',
              toolName: 'read',
              args: { path: 'src/runtime/pi-executor.ts' },
            }),
          ],
          3: [
            progressEvent('run-tool-snippets', 'tool_execution_end', {
              toolCallId: 'read-1',
              toolName: 'read',
              result: { text: 'very long file output that should not show up here' },
              isError: false,
            }),
          ],
          4: [
            progressEvent('run-tool-snippets', 'tool_execution_start', {
              toolCallId: 'edit-1',
              toolName: 'edit',
              args: {
                path: 'src/adapters/telegram-progress.ts',
                oldText: 'old value',
                newText: 'new value',
              },
            }),
          ],
          5: [
            progressEvent('run-tool-snippets', 'tool_execution_end', {
              toolCallId: 'edit-1',
              toolName: 'edit',
              result: { ok: true },
              isError: false,
            }),
          ],
          6: [
            progressEvent('run-tool-snippets', 'tool_execution_start', {
              toolCallId: 'write-1',
              toolName: 'write',
              args: { path: 'notes/output.txt', content: 'some generated text' },
            }),
          ],
          7: [
            progressEvent('run-tool-snippets', 'tool_execution_end', {
              toolCallId: 'write-1',
              toolName: 'write',
              result: { ok: true },
              isError: false,
            }),
          ],
          8: [
            progressEvent('run-tool-snippets', 'tool_execution_start', {
              toolCallId: 'bash-1',
              toolName: 'bash',
              args: { command: longCommand },
            }),
          ],
          9: [
            progressEvent('run-tool-snippets', 'tool_execution_end', {
              toolCallId: 'bash-1',
              toolName: 'bash',
              result: { stdout: 'done', stderr: '' },
              isError: false,
            }),
          ],
        },
      },
    );

    await withTelegramAdapter(
      {
        runService: runService.asRunService(),
        waitTimeoutMs: 4_000,
        pollIntervalMs: 200,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'show tool snippets',
        });

        const progressEdit = await clone.waitForBotCall(
          'editMessageText',
          (call) =>
            typeof call.payload.text === 'string' &&
            call.payload.text.includes('> read path=src/runtime/pi-executor.ts') &&
            call.payload.text.includes('> edit path=src/adapters/telegram-progress.ts') &&
            call.payload.text.includes('> write path=notes/output.txt') &&
            call.payload.text.includes('> bash cmd="'),
          8_000,
        );

        const progressText = String(progressEdit.payload.text ?? '');
        expect(progressText).toContain('> read path=src/runtime/pi-executor.ts');
        expect(progressText).toContain('> edit path=src/adapters/telegram-progress.ts');
        expect(progressText).toContain('> write path=notes/output.txt');
        expect(progressText).toContain('> bash cmd="');
        expect(progressText).not.toContain('very long file output that should not show up here');

        const readIndex = progressText.indexOf('> read path=src/runtime/pi-executor.ts');
        const editIndex = progressText.indexOf('> edit path=src/adapters/telegram-progress.ts');
        const writeIndex = progressText.indexOf('> write path=notes/output.txt');
        const bashIndex = progressText.indexOf('> bash cmd="');
        expect(readIndex).toBeGreaterThan(-1);
        expect(editIndex).toBeGreaterThan(readIndex);
        expect(writeIndex).toBeGreaterThan(editIndex);
        expect(bashIndex).toBeGreaterThan(writeIndex);

        const finalMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === 'Tool snippets done',
          8_000,
        );
        expect(finalMessage.payload.text).toBe('Tool snippets done');
      },
    );
  }, 14_000);

  test('retries progress edits after Telegram 429 retry_after responses', async () => {
    const runningState = runRecord({
      runId: 'run-edit-retry',
      status: 'running',
      output: null,
      errorMessage: null,
    });
    const completedState = runRecord({
      runId: 'run-edit-retry',
      status: 'succeeded',
      output: { text: 'Edit retry done' },
      errorMessage: null,
    });

    const runService = new StubRunService(
      'run-edit-retry',
      [
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        runningState,
        completedState,
      ],
      {
        progressEventsByPoll: {
          1: [progressEvent('run-edit-retry', 'started')],
          2: [
            progressEvent('run-edit-retry', 'assistant_text_delta', {
              delta: 'progress text',
            }),
          ],
          3: [
            progressEvent('run-edit-retry', 'assistant_text_delta', {
              delta: 'more progress text',
            }),
          ],
        },
      },
    );

    await withTelegramAdapter(
      {
        runService: runService.asRunService(),
        waitTimeoutMs: 4_000,
        pollIntervalMs: 200,
      },
      async ({ clone }) => {
        clone.failNextApiCall('editMessageText', {
          errorCode: 429,
          description: 'Too Many Requests: retry later',
          parameters: {
            retry_after: 0.05,
          },
        });

        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'retry edits',
        });

        const finalMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === 'Edit retry done',
          6_000,
        );
        expect(finalMessage.payload.text).toBe('Edit retry done');

        expect(clone.getApiCallCount('editMessageText')).toBeGreaterThanOrEqual(2);
      },
    );
  }, 12_000);

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
          (call) => call.payload.text === "Still running. I'll send the result when it's done.",
        );
        expect(sendMessage.payload.text).toBe("Still running. I'll send the result when it's done.");
      },
    );
  });

  test('sends final output later when initial wait times out', async () => {
    const runService = new StubRunService('run-late-complete', [
      runRecord({
        runId: 'run-late-complete',
        status: 'running',
      }),
      runRecord({
        runId: 'run-late-complete',
        status: 'running',
      }),
      runRecord({
        runId: 'run-late-complete',
        status: 'running',
      }),
      runRecord({
        runId: 'run-late-complete',
        status: 'succeeded',
        output: { text: 'Finished later' },
      }),
    ]);

    await withTelegramAdapter(
      {
        runService: runService.asRunService(),
        waitTimeoutMs: 15,
        pollIntervalMs: 10,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'complete later',
        });

        const queuedMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === "Still running. I'll send the result when it's done.",
        );
        expect(queuedMessage.payload.text).toContain('Still running');

        const finalMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === 'Finished later',
          3_000,
        );
        expect(finalMessage.payload.text).toBe('Finished later');
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
        .filter((text): text is string => typeof text === 'string')
        .filter((text) => /^x+$/.test(text));

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
  private readonly runProgressListeners = new Set<(event: RunProgressEvent) => void>();

  constructor(
    private readonly runId: string,
    private readonly runStates: RunRecord[],
    private readonly options: {
      progressEventsByPoll?: Record<number, RunProgressEvent[]>;
    } = {},
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

        const progressEvents = this.options.progressEventsByPoll?.[this.pollCount] ?? [];
        for (const event of progressEvents) {
          this.emitRunProgress(event);
        }

        return this.runStates[stateIndex] ?? null;
      },
      subscribeRunProgress: (_runId: string, listener: (event: RunProgressEvent) => void) => {
        this.runProgressListeners.add(listener);

        return () => {
          this.runProgressListeners.delete(listener);
        };
      },
    } as unknown as RunService;
  }

  private emitRunProgress(event: RunProgressEvent): void {
    for (const listener of this.runProgressListeners) {
      listener(event);
    }
  }
}

function progressEvent(
  runId: string,
  type: RunProgressEvent['type'],
  extra: Record<string, unknown> = {},
): RunProgressEvent {
  const base = {
    runId,
    threadKey: 'telegram:chat:101',
    source: 'telegram',
    deliveryMode: 'followUp' as const,
    timestamp: new Date().toISOString(),
  };

  switch (type) {
    case 'queued':
    case 'started':
    case 'delivered':
    case 'agent_start':
    case 'agent_end':
      return {
        ...base,
        type,
      };
    case 'turn_start':
      return {
        ...base,
        type,
      };
    case 'turn_end':
      return {
        ...base,
        type,
        toolResultCount: Number(extra.toolResultCount ?? 0),
      };
    case 'assistant_text_delta':
      return {
        ...base,
        type,
        delta: String(extra.delta ?? ''),
      };
    case 'assistant_thinking_delta':
      return {
        ...base,
        type,
        delta: String(extra.delta ?? ''),
      };
    case 'tool_execution_start':
      return {
        ...base,
        type,
        toolCallId: String(extra.toolCallId ?? 'tool'),
        toolName: String(extra.toolName ?? 'tool'),
        args: extra.args ?? {},
      };
    case 'tool_execution_update':
      return {
        ...base,
        type,
        toolCallId: String(extra.toolCallId ?? 'tool'),
        toolName: String(extra.toolName ?? 'tool'),
        partialResult: extra.partialResult ?? {},
      };
    case 'tool_execution_end':
      return {
        ...base,
        type,
        toolCallId: String(extra.toolCallId ?? 'tool'),
        toolName: String(extra.toolName ?? 'tool'),
        result: extra.result ?? {},
        isError: Boolean(extra.isError),
      };
    case 'succeeded':
      return {
        ...base,
        type,
        output: (extra.output ?? {}) as Record<string, unknown>,
      };
    case 'failed':
      return {
        ...base,
        type,
        errorMessage: String(extra.errorMessage ?? 'failed'),
      };
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
