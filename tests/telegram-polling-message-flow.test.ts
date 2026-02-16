import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, test, vi } from 'vitest';

import type { RunService } from '../src/server/service.js';
import type { RunProgressEvent } from '../src/shared/run-progress.js';
import type { MessageIngest, RunRecord } from '../src/shared/run-types.js';
import {
  createThreadRuntimeState,
  FakeThreadControlService,
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

  test('routes topic-thread messages to topic thread keys and sends topic-aware delivery payloads', async () => {
    const topicThreadId = 333;
    const largeCode = Array.from({ length: 90 }, (_, index) => `const item${index}: number = ${index};`).join('\n');
    const output = ['```ts', largeCode, '```'].join('\n');

    const runningState = runRecord({
      runId: 'run-topic-route',
      status: 'running',
      output: null,
      errorMessage: null,
    });
    const completedState = runRecord({
      runId: 'run-topic-route',
      status: 'succeeded',
      output: { text: output },
      errorMessage: null,
    });

    const runService = new StubRunService(
      'run-topic-route',
      [runningState, runningState, runningState, completedState],
      {
        progressEventsByPoll: {
          1: [progressEvent('run-topic-route', 'started')],
          2: [
            progressEvent('run-topic-route', 'tool_execution_start', {
              toolCallId: 'topic-tool-1',
              toolName: 'bash',
              args: { command: 'echo topic' },
            }),
          ],
        },
      },
    );

    await withTelegramAdapter(
      {
        runService: runService.asRunService(),
        pollIntervalMs: 100,
      },
      async ({ clone }) => {
        const updateId = clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'topic thread please',
          messageThreadId: topicThreadId,
        });

        await clone.waitForBotCall('sendChatAction', (call) => call.payload.message_thread_id === topicThreadId, 4_000);

        await clone.waitForBotCall(
          'editMessageText',
          (call) => call.payload.message_thread_id === topicThreadId,
          6_000,
        );

        await clone.waitForBotCall(
          'sendDocument',
          (call) => Number(call.payload.message_thread_id ?? 0) === topicThreadId,
          8_000,
        );

        const terminal = await clone.waitForBotCall(
          'sendMessage',
          (call) =>
            call.payload.message_thread_id === topicThreadId && call.payload.text === '📎 attached code: snippet-1.ts',
          8_000,
        );
        expect(terminal.payload.message_thread_id).toBe(topicThreadId);

        expect(runService.ingests).toEqual([
          {
            source: 'telegram',
            threadKey: `telegram:chat:101:topic:${topicThreadId}`,
            userKey: 'telegram:user:202',
            text: 'topic thread please',
            deliveryMode: 'followUp',
            idempotencyKey: `telegram:update:${updateId}`,
          },
        ]);
      },
    );
  }, 14_000);

  test('normalizes general topic thread id 1 to base chat routing and payloads', async () => {
    const runService = new StubRunService('run-general-topic', [
      runRecord({
        runId: 'run-general-topic',
        status: 'succeeded',
        output: { text: 'general topic normalized' },
      }),
    ]);

    await withTelegramAdapter({ runService: runService.asRunService() }, async ({ clone }) => {
      const updateId = clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: 'general topic route',
        messageThreadId: 1,
      });

      const sendMessage = await clone.waitForBotCall(
        'sendMessage',
        (call) => call.payload.text === 'general topic normalized',
      );
      expect(sendMessage.payload.message_thread_id).toBeUndefined();

      expect(runService.ingests).toEqual([
        {
          source: 'telegram',
          threadKey: 'telegram:chat:101',
          userKey: 'telegram:user:202',
          text: 'general topic route',
          deliveryMode: 'followUp',
          idempotencyKey: `telegram:update:${updateId}`,
        },
      ]);
    });
  });

  test('deletes startup-only progress messages in topic threads with message_thread_id', async () => {
    const topicThreadId = 444;
    const runningState = runRecord({
      runId: 'run-topic-delete',
      status: 'running',
      output: null,
      errorMessage: null,
    });
    const completedState = runRecord({
      runId: 'run-topic-delete',
      status: 'succeeded',
      output: { text: 'topic done' },
      errorMessage: null,
    });

    const runService = new StubRunService('run-topic-delete', [runningState, runningState, completedState]);

    await withTelegramAdapter(
      {
        runService: runService.asRunService(),
        pollIntervalMs: 100,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'topic delete placeholder',
          messageThreadId: topicThreadId,
        });

        const deleteCall = await clone.waitForBotCall(
          'deleteMessage',
          (call) => call.payload.message_thread_id === topicThreadId,
          5_000,
        );

        expect(deleteCall.payload.chat_id).toBe(testChatId);
        expect(deleteCall.payload.message_thread_id).toBe(topicThreadId);
      },
    );
  });

  test('renders markdown output using Telegram entities', async () => {
    const markdownOutput = [
      'Hello **world** and `inline` code with [docs](https://example.com).',
      '',
      '```ts',
      'const answer: number = 42;',
      '```',
    ].join('\n');

    const runService = new StubRunService('run-markdown-entities', [
      runRecord({
        runId: 'run-markdown-entities',
        status: 'succeeded',
        output: { text: markdownOutput },
      }),
    ]);

    await withTelegramAdapter({ runService: runService.asRunService() }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: 'render markdown please',
      });

      const sendMessage = await clone.waitForBotCall(
        'sendMessage',
        (call) => typeof call.payload.text === 'string' && call.payload.text.includes('const answer: number = 42;'),
      );

      expect(sendMessage.payload.text).toContain('Hello world and inline code with docs.');

      const entities = sendMessage.payload.entities as Array<{ type?: string }>;
      expect(Array.isArray(entities)).toBe(true);
      expect(entities.some((entity) => entity.type === 'bold')).toBe(true);
      expect(entities.some((entity) => entity.type === 'code')).toBe(true);
      expect(entities.some((entity) => entity.type === 'text_link')).toBe(true);
      expect(entities.some((entity) => entity.type === 'pre')).toBe(true);
    });
  });

  test('sends oversized code blocks as language-aware document attachments', async () => {
    const largeCode = Array.from({ length: 90 }, (_, index) => `const value${index}: number = ${index};`).join('\n');
    const output = ['```typescript', largeCode, '```'].join('\n');

    const runService = new StubRunService('run-markdown-attachment', [
      runRecord({
        runId: 'run-markdown-attachment',
        status: 'succeeded',
        output: { text: output },
      }),
    ]);

    await withTelegramAdapter({ runService: runService.asRunService() }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: 'render attachment please',
      });

      const attachmentNotice = await clone.waitForBotCall(
        'sendMessage',
        (call) => call.payload.text === '📎 attached code: snippet-1.ts',
      );
      expect(attachmentNotice.payload.text).toBe('📎 attached code: snippet-1.ts');

      const documentCall = await clone.waitForBotCall('sendDocument');
      expect(documentCall.payload.caption).toBe('📎 snippet-1.ts (typescript)');

      const attachmentFieldName = String(documentCall.payload.document).replace('attach://', '');
      const attachmentContent = documentCall.payload[attachmentFieldName];
      expect(typeof attachmentContent).toBe('string');
      expect(String(attachmentContent)).toContain('const value0: number = 0;');
    });
  });

  test('accepts authorized users when allowlist entry has leading zeroes', async () => {
    const runService = new StubRunService('run-leading-zero-allow', [
      runRecord({
        runId: 'run-leading-zero-allow',
        status: 'succeeded',
        output: { text: 'allowed through' },
      }),
    ]);

    await withTelegramAdapter(
      {
        runService: runService.asRunService(),
        allowedTelegramUserIds: ['000202'],
      },
      async ({ clone }) => {
        const updateId = clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'hello leading zero allowlist',
        });

        const reply = await clone.waitForBotCall('sendMessage', (call) => call.payload.text === 'allowed through');
        expect(reply.payload.text).toBe('allowed through');
        expect(runService.ingests).toEqual([
          {
            source: 'telegram',
            threadKey: 'telegram:chat:101',
            userKey: 'telegram:user:202',
            text: 'hello leading zero allowlist',
            deliveryMode: 'followUp',
            idempotencyKey: `telegram:update:${updateId}`,
          },
        ]);
      },
    );
  });

  test('blocks unauthorized users and returns exact allow command', async () => {
    const runService = new StubRunService('run-unauthorized', [
      runRecord({
        runId: 'run-unauthorized',
        status: 'succeeded',
        output: { text: 'should not run' },
      }),
    ]);

    await withTelegramAdapter(
      {
        runService: runService.asRunService(),
        allowedTelegramUserIds: [],
        workspaceDir: '/tmp/_jagc-workspace_',
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'hello there',
        });

        const denial = await clone.waitForBotCall(
          'sendMessage',
          (call) =>
            typeof call.payload.text === 'string' &&
            call.payload.text.includes('jagc telegram allow --user-id 202 --workspace-dir /tmp/_jagc-workspace_'),
        );

        expect(String(denial.payload.text)).toContain('This bot is private');
        expect(runService.ingests).toEqual([]);
      },
    );
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
          (call) => isFunnyProgressLine(call.payload.text),
          4_000,
        );

        const startupProgressLine = String(progressMessage.payload.text ?? '');
        expect(isFunnyProgressLine(startupProgressLine)).toBe(true);

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
        expect(progressEdit.payload.text).not.toContain(startupProgressLine);
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

  test('edits tool progress in place with done marker and duration', async () => {
    const runningState = runRecord({
      runId: 'run-tool-inline-status',
      status: 'running',
      output: null,
      errorMessage: null,
    });
    const completedState = runRecord({
      runId: 'run-tool-inline-status',
      status: 'succeeded',
      output: { text: 'Inline status done' },
      errorMessage: null,
    });

    const runService = new StubRunService(
      'run-tool-inline-status',
      [runningState, runningState, runningState, runningState, runningState, completedState],
      {
        progressEventsByPoll: {
          1: [progressEvent('run-tool-inline-status', 'started')],
          2: [
            progressEvent('run-tool-inline-status', 'tool_execution_start', {
              toolCallId: 'tool-inline-1',
              toolName: 'bash',
              args: { command: 'pwd; ls -la' },
            }),
          ],
          3: [
            progressEvent('run-tool-inline-status', 'tool_execution_end', {
              toolCallId: 'tool-inline-1',
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
        pollIntervalMs: 150,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'show inline status',
        });

        const progressEdit = await clone.waitForBotCall(
          'editMessageText',
          (call) =>
            typeof call.payload.text === 'string' && call.payload.text.includes('> bash cmd="pwd; ls -la" [✓] done ('),
          8_000,
        );

        const progressText = String(progressEdit.payload.text ?? '');
        const commandPrefix = '> bash cmd="pwd; ls -la"';
        const commandOccurrenceCount = progressText.split(commandPrefix).length - 1;

        expect(commandOccurrenceCount).toBe(1);
        expect(progressText).toMatch(/> bash cmd="pwd; ls -la" \[✓\] done \(\d+\.\ds\)/u);

        const finalMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === 'Inline status done',
          8_000,
        );
        expect(finalMessage.payload.text).toBe('Inline status done');
      },
    );
  }, 14_000);

  test('edits tool progress in place with failed marker and duration', async () => {
    const runningState = runRecord({
      runId: 'run-tool-inline-failed-status',
      status: 'running',
      output: null,
      errorMessage: null,
    });
    const completedState = runRecord({
      runId: 'run-tool-inline-failed-status',
      status: 'succeeded',
      output: { text: 'Inline failed status done' },
      errorMessage: null,
    });

    const runService = new StubRunService(
      'run-tool-inline-failed-status',
      [runningState, runningState, runningState, runningState, runningState, completedState],
      {
        progressEventsByPoll: {
          1: [progressEvent('run-tool-inline-failed-status', 'started')],
          2: [
            progressEvent('run-tool-inline-failed-status', 'tool_execution_start', {
              toolCallId: 'tool-inline-fail-1',
              toolName: 'bash',
              args: { command: 'cat missing.txt' },
            }),
          ],
          3: [
            progressEvent('run-tool-inline-failed-status', 'tool_execution_end', {
              toolCallId: 'tool-inline-fail-1',
              toolName: 'bash',
              result: { stderr: 'No such file' },
              isError: true,
            }),
          ],
        },
      },
    );

    await withTelegramAdapter(
      {
        runService: runService.asRunService(),
        pollIntervalMs: 150,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'show inline failed status',
        });

        const progressEdit = await clone.waitForBotCall(
          'editMessageText',
          (call) =>
            typeof call.payload.text === 'string' &&
            call.payload.text.includes('> bash cmd="cat missing.txt" [✗] failed ('),
          8_000,
        );

        const progressText = String(progressEdit.payload.text ?? '');
        const commandPrefix = '> bash cmd="cat missing.txt"';
        const commandOccurrenceCount = progressText.split(commandPrefix).length - 1;

        expect(commandOccurrenceCount).toBe(1);
        expect(progressText).toMatch(/> bash cmd="cat missing.txt" \[✗\] failed \(\d+\.\ds\)/u);
        expect(progressText).not.toContain('[✓] done');

        const finalMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === 'Inline failed status done',
          8_000,
        );
        expect(finalMessage.payload.text).toBe('Inline failed status done');
      },
    );
  }, 14_000);

  test('deletes startup progress placeholder when run has no thinking/tool snippets', async () => {
    const runningState = runRecord({
      runId: 'run-no-snippets',
      status: 'running',
      output: null,
      errorMessage: null,
    });
    const completedState = runRecord({
      runId: 'run-no-snippets',
      status: 'succeeded',
      output: { text: 'hello back' },
      errorMessage: null,
    });

    const runService = new StubRunService('run-no-snippets', [runningState, runningState, completedState]);

    await withTelegramAdapter(
      {
        runService: runService.asRunService(),
        pollIntervalMs: 100,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'hi',
        });

        const startupMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => isFunnyProgressLine(call.payload.text),
          4_000,
        );
        expect(isFunnyProgressLine(startupMessage.payload.text)).toBe(true);

        const deleteCall = await clone.waitForBotCall(
          'deleteMessage',
          (call) => call.payload.chat_id === testChatId,
          4_000,
        );
        expect(deleteCall.payload.chat_id).toBe(testChatId);
        expect(typeof deleteCall.payload.message_id).toBe('number');

        const finalMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === 'hello back',
          4_000,
        );
        expect(finalMessage.payload.text).toBe('hello back');

        expect(clone.getApiCallCount('editMessageText')).toBe(0);

        const botCalls = clone.getBotCalls();
        const deleteIndex = botCalls.findIndex((call) => call.method === 'deleteMessage');
        const finalMessageIndex = botCalls.findIndex(
          (call) => call.method === 'sendMessage' && call.payload.text === 'hello back',
        );

        expect(deleteIndex).toBeGreaterThan(-1);
        expect(finalMessageIndex).toBeGreaterThan(deleteIndex);
      },
    );
  });

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
        pollIntervalMs: 200,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'show latest thinking preview',
        });

        const progressMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => isFunnyProgressLine(call.payload.text),
          4_000,
        );

        const startupProgressLine = String(progressMessage.payload.text ?? '');

        const progressEdit = await clone.waitForBotCall(
          'editMessageText',
          (call) =>
            typeof call.payload.text === 'string' &&
            call.payload.text.includes('> bash cmd="find . -maxdepth 1 -type d"'),
          8_000,
        );

        expect(progressEdit.payload.text).toContain('~ **Listing directories');
        expect(progressEdit.payload.text).toContain('> bash cmd="find . -maxdepth 1 -type d"');
        expect(progressEdit.payload.text).not.toContain(startupProgressLine);

        const finalMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === 'Thinking flush done',
          8_000,
        );
        expect(finalMessage.payload.text).toBe('Thinking flush done');
      },
    );
  }, 14_000);

  test('keeps separate thinking snippets across tool events even when content index stays the same', async () => {
    const runningState = runRecord({
      runId: 'run-thinking-content-blocks',
      status: 'running',
      output: null,
      errorMessage: null,
    });
    const completedState = runRecord({
      runId: 'run-thinking-content-blocks',
      status: 'succeeded',
      output: { text: 'Thinking content blocks done' },
      errorMessage: null,
    });

    const runService = new StubRunService(
      'run-thinking-content-blocks',
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
          1: [progressEvent('run-thinking-content-blocks', 'started')],
          2: [
            progressEvent('run-thinking-content-blocks', 'assistant_thinking_delta', {
              delta: '**Planning recommendations for AGENTS.md**',
              contentIndex: 0,
            }),
          ],
          3: [
            progressEvent('run-thinking-content-blocks', 'tool_execution_start', {
              toolCallId: 'tool-1',
              toolName: 'read',
              args: { path: '/Users/akuzmenko/.jagc/skills/agents-md/SKILL.md' },
            }),
          ],
          4: [
            progressEvent('run-thinking-content-blocks', 'tool_execution_end', {
              toolCallId: 'tool-1',
              toolName: 'read',
              result: { ok: true },
              isError: false,
            }),
          ],
          5: [
            progressEvent('run-thinking-content-blocks', 'assistant_thinking_delta', {
              delta: '**Planning to read agents file**',
              contentIndex: 0,
            }),
          ],
          6: [
            progressEvent('run-thinking-content-blocks', 'tool_execution_start', {
              toolCallId: 'tool-2',
              toolName: 'read',
              args: { path: '/Users/akuzmenko/.jagc/AGENTS.md' },
            }),
          ],
          7: [
            progressEvent('run-thinking-content-blocks', 'tool_execution_end', {
              toolCallId: 'tool-2',
              toolName: 'read',
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
        pollIntervalMs: 200,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'show thinking content blocks',
        });

        const finalMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === 'Thinking content blocks done',
          8_000,
        );
        expect(finalMessage.payload.text).toBe('Thinking content blocks done');

        const progressEdit = [...clone.getBotCalls()]
          .reverse()
          .find(
            (call) =>
              call.method === 'editMessageText' &&
              typeof call.payload.text === 'string' &&
              call.payload.text.includes('~ Planning to read agents file') &&
              call.payload.text.includes('> read path=/Users/akuzmenko/.jagc/AGENTS.md [✓] done ('),
          );

        expect(progressEdit).toBeDefined();

        const progressText = String(progressEdit?.payload.text ?? '');
        expect(progressText).toContain('~ Planning recommendations for AGENTS.md');
        expect(progressText).toContain('~ Planning to read agents file');
        expect(progressText).not.toContain('~ Planning recommendations for AGENTS.mdPlanning to read agents file');

        const progressEntities = (progressEdit?.payload.entities ?? []) as Array<{ type?: string }>;
        expect(progressEntities.some((entity) => entity.type === 'bold')).toBe(true);
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
            progressEvent('run-edit-retry', 'tool_execution_start', {
              toolCallId: 'retry-tool',
              toolName: 'bash',
              args: { command: 'echo retry' },
            }),
          ],
          3: [
            progressEvent('run-edit-retry', 'tool_execution_end', {
              toolCallId: 'retry-tool',
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

  test('unknown slash commands are forwarded as followUp messages', async () => {
    const runService = new StubRunService('run-handoff', [
      runRecord({
        runId: 'run-handoff',
        status: 'succeeded',
        output: { text: 'Handoff done' },
      }),
    ]);

    await withTelegramAdapter({ runService: runService.asRunService() }, async ({ clone }) => {
      clone.injectTextMessage({
        chatId: testChatId,
        fromId: testUserId,
        text: '/handoff',
      });

      const sendMessage = await clone.waitForBotCall('sendMessage', (call) => call.payload.text === 'Handoff done');
      expect(sendMessage.payload.text).toBe('Handoff done');

      expect(runService.ingests).toHaveLength(1);
      expect(runService.ingests[0]).toMatchObject({
        source: 'telegram',
        threadKey: 'telegram:chat:101',
        userKey: 'telegram:user:202',
        text: '/handoff',
        deliveryMode: 'followUp',
      });

      expect(
        clone
          .getBotCalls()
          .some((call) => call.method === 'sendMessage' && call.payload.text === 'Unknown command: /handoff'),
      ).toBe(false);
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

  test('cancel command suppresses terminal aborted-run error reply for the active chat run', async () => {
    const abortedErrorMessage = 'run run-cancel-active failed: This operation was aborted';
    const runService = new StubRunService('run-cancel-active', [
      runRecord({
        runId: 'run-cancel-active',
        status: 'running',
        output: null,
        errorMessage: null,
      }),
      runRecord({
        runId: 'run-cancel-active',
        status: 'running',
        output: null,
        errorMessage: null,
      }),
      runRecord({
        runId: 'run-cancel-active',
        status: 'failed',
        output: null,
        errorMessage: abortedErrorMessage,
      }),
    ]);

    const threadControlService = new FakeThreadControlService(createThreadRuntimeState());

    await withTelegramAdapter(
      {
        runService: runService.asRunService(),
        threadControlService,
        pollIntervalMs: 75,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'start and then cancel',
        });

        await clone.waitForBotCall('sendMessage', (call) => isFunnyProgressLine(call.payload.text), 4_000);

        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: '/cancel',
        });

        await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === '🛑 Stopped the active run. Session context is preserved.',
          4_000,
        );

        await sleep(500);

        const failureReplies = clone
          .getBotCalls()
          .filter((call) => call.method === 'sendMessage')
          .map((call) => call.payload.text)
          .filter((text): text is string => typeof text === 'string')
          .filter((text) => text === `❌ ${abortedErrorMessage}`);

        expect(failureReplies).toHaveLength(0);
      },
    );
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

  test('does not send timeout handoff text while run is still in progress', async () => {
    const running = runRecord({
      runId: 'run-timeout-removed',
      status: 'running',
      output: null,
      errorMessage: null,
    });
    const runService = new StubRunService('run-timeout-removed', [running]);

    await withTelegramAdapter(
      {
        runService: runService.asRunService(),
        pollIntervalMs: 5,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'still running?',
        });

        await clone.waitForBotCall('sendMessage', (call) => isFunnyProgressLine(call.payload.text), 3_000);
        await sleep(200);

        const timeoutHandoffMessages = clone
          .getBotCalls()
          .filter((call) => call.method === 'sendMessage')
          .map((call) => call.payload.text)
          .filter((text): text is string => typeof text === 'string')
          .filter((text) => text === "Still running. I'll send the result when it's done.");

        expect(timeoutHandoffMessages).toHaveLength(0);
      },
    );
  });

  test('sends final output later without timeout handoff text', async () => {
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
        pollIntervalMs: 10,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'complete later',
        });

        const finalMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === 'Finished later',
          3_000,
        );
        expect(finalMessage.payload.text).toBe('Finished later');

        const timeoutHandoffMessages = clone
          .getBotCalls()
          .filter((call) => call.method === 'sendMessage')
          .map((call) => call.payload.text)
          .filter((text): text is string => typeof text === 'string')
          .filter((text) => text === "Still running. I'll send the result when it's done.");

        expect(timeoutHandoffMessages).toHaveLength(0);
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

  test('splits long progress streams into additional Telegram messages', async () => {
    const toolEventCount = 34;
    const runStates: RunRecord[] = [];
    for (let i = 0; i < toolEventCount + 2; i += 1) {
      runStates.push(
        runRecord({
          runId: 'run-progress-overflow',
          status: 'running',
          output: null,
          errorMessage: null,
        }),
      );
    }

    runStates.push(
      runRecord({
        runId: 'run-progress-overflow',
        status: 'succeeded',
        output: { text: 'Overflow done' },
        errorMessage: null,
      }),
    );

    const progressEventsByPoll: Record<number, RunProgressEvent[]> = {
      1: [progressEvent('run-progress-overflow', 'started')],
    };

    for (let i = 0; i < toolEventCount; i += 1) {
      progressEventsByPoll[i + 2] = [
        progressEvent('run-progress-overflow', 'tool_execution_start', {
          toolCallId: `overflow-tool-${i}`,
          toolName: 'bash',
          args: {
            command: `echo step-${i} ${'x'.repeat(120)}`,
          },
        }),
      ];
    }

    const runService = new StubRunService('run-progress-overflow', runStates, {
      progressEventsByPoll,
    });

    await withTelegramAdapter(
      {
        runService: runService.asRunService(),
        pollIntervalMs: 20,
      },
      async ({ clone }) => {
        clone.injectTextMessage({
          chatId: testChatId,
          fromId: testUserId,
          text: 'show overflowing progress',
        });

        const finalMessage = await clone.waitForBotCall(
          'sendMessage',
          (call) => call.payload.text === 'Overflow done',
          12_000,
        );
        expect(finalMessage.payload.text).toBe('Overflow done');

        const progressArchiveMessages = clone
          .getBotCalls()
          .filter((call) => call.method === 'sendMessage')
          .map((call) => call.payload.text)
          .filter((text): text is string => typeof text === 'string')
          .filter((text) => text.startsWith('progress log (continued):'));

        expect(progressArchiveMessages.length).toBeGreaterThan(0);
        expect(progressArchiveMessages.join('\n')).toContain('> bash cmd="echo step-');
      },
    );
  }, 20_000);

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

function isFunnyProgressLine(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]+\.\.\.$/u.test(value);
}

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
        ...(typeof extra.contentIndex === 'number' ? { contentIndex: extra.contentIndex } : {}),
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
