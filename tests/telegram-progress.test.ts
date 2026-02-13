import type { Bot } from 'grammy';
import { describe, expect, test, vi } from 'vitest';

import { TelegramRunProgressReporter } from '../src/adapters/telegram-progress.js';
import { noopLogger } from '../src/shared/logger.js';
import type { RunProgressEvent } from '../src/shared/run-progress.js';

describe('TelegramRunProgressReporter archive flushing', () => {
  test('retains only unsent archive lines after a mid-flush send failure', async () => {
    const sentChunks: string[] = [];
    let sendAttempt = 0;

    const bot = {
      api: {
        sendMessage: vi.fn(async (_chatId: number, text: string) => {
          sendAttempt += 1;
          if (sendAttempt === 2) {
            throw new Error('temporary telegram outage');
          }

          sentChunks.push(text);
          return { message_id: sendAttempt };
        }),
        editMessageText: vi.fn(),
        sendChatAction: vi.fn(),
        deleteMessage: vi.fn(),
      },
    } as unknown as Bot;

    const reporter = new TelegramRunProgressReporter({
      bot,
      chatId: 101,
      runId: 'run-archive-mid-flush-failure',
      logger: noopLogger,
      messageLimit: 80,
      minEditIntervalMs: 0,
    });

    const lines = Array.from({ length: 8 }, (_, index) => `> bash cmd="echo step-${index} ${'x'.repeat(24)}"`);
    const state = reporter as unknown as {
      pendingArchiveLines: string[];
      flushPendingArchiveLines: (force: boolean) => Promise<void>;
    };
    state.pendingArchiveLines = [...lines];

    await expect(state.flushPendingArchiveLines(true)).rejects.toThrow('temporary telegram outage');

    expect(sentChunks).toHaveLength(1);
    const firstDeliveredLines = archiveChunkLines(sentChunks[0] ?? '');
    expect(firstDeliveredLines.length).toBeGreaterThan(0);
    expect(state.pendingArchiveLines).toEqual(lines.slice(firstDeliveredLines.length));

    await state.flushPendingArchiveLines(true);

    const deliveredLines = sentChunks.flatMap((chunk) => archiveChunkLines(chunk));
    expect(deliveredLines).toEqual(lines);
    expect(state.pendingArchiveLines).toEqual([]);
  });

  test('keeps render retry pending when archive send fails with non-rate-limit error', async () => {
    let failArchiveSend = true;

    const bot = {
      api: {
        sendMessage: vi.fn(async () => {
          if (failArchiveSend) {
            failArchiveSend = false;
            throw new Error('temporary telegram outage');
          }

          return { message_id: 1 };
        }),
        editMessageText: vi.fn(async () => ({ message_id: 1 })),
        sendChatAction: vi.fn(),
        deleteMessage: vi.fn(),
      },
    } as unknown as Bot;

    const reporter = new TelegramRunProgressReporter({
      bot,
      chatId: 101,
      runId: 'run-archive-retry-pending',
      logger: noopLogger,
      messageLimit: 120,
      minEditIntervalMs: 0,
    });

    const state = reporter as unknown as {
      pendingArchiveLines: string[];
      pendingRender: boolean;
      phase: 'queued' | 'running' | 'succeeded' | 'failed';
      progressMessageId: number | null;
      flushRender: () => Promise<void>;
    };

    state.pendingArchiveLines = Array.from(
      { length: 12 },
      (_, index) => `> bash cmd="echo step-${index} ${'x'.repeat(16)}"`,
    );
    state.pendingRender = true;
    state.phase = 'succeeded';
    state.progressMessageId = 1;

    await state.flushRender();

    expect(state.pendingRender).toBe(true);
    expect(state.pendingArchiveLines.length).toBeGreaterThan(0);

    await state.flushRender();

    expect(state.pendingArchiveLines).toEqual([]);
  });
});

describe('TelegramRunProgressReporter edit recovery', () => {
  test('recreates progress message with entities preserved after message-gone edit failures', async () => {
    const sendCalls: Array<{ text: string; entities: Array<{ type?: string }> }> = [];

    const bot = {
      api: {
        sendMessage: vi.fn(async (_chatId: number, text: string, options?: { entities?: Array<{ type?: string }> }) => {
          sendCalls.push({ text, entities: options?.entities ?? [] });
          return { message_id: sendCalls.length };
        }),
        editMessageText: vi.fn(async () => {
          throw new Error('message to edit not found');
        }),
        sendChatAction: vi.fn(),
        deleteMessage: vi.fn(),
      },
    } as unknown as Bot;

    const reporter = new TelegramRunProgressReporter({
      bot,
      chatId: 101,
      runId: 'run-thinking-format',
      logger: noopLogger,
      minEditIntervalMs: 0,
    });

    await reporter.start();

    reporter.onProgress(
      progressEvent('assistant_thinking_delta', {
        delta: '**Bold think**',
        contentIndex: 0,
      }),
    );
    reporter.onProgress(
      progressEvent('assistant_text_delta', {
        delta: 'continuing run',
      }),
    );

    await reporter.finishSucceeded();

    expect(sendCalls.length).toBeGreaterThanOrEqual(2);

    const recreatedProgress = sendCalls[1];
    expect(recreatedProgress?.text).toContain('~ Bold think');
    expect(recreatedProgress?.entities.some((entity) => entity.type === 'bold')).toBe(true);
  });

  test('keeps tool-call labels literal while rendering thinking snippets as entities', async () => {
    const editCalls: Array<{ text: string; entities: Array<{ type?: string }> }> = [];

    const bot = {
      api: {
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        editMessageText: vi.fn(
          async (
            _chatId: number,
            _messageId: number,
            text: string,
            options?: { entities?: Array<{ type?: string }> },
          ) => {
            editCalls.push({ text, entities: options?.entities ?? [] });
            return { message_id: 1 };
          },
        ),
        sendChatAction: vi.fn(),
        deleteMessage: vi.fn(),
      },
    } as unknown as Bot;

    const reporter = new TelegramRunProgressReporter({
      bot,
      chatId: 101,
      runId: 'run-thinking-format',
      logger: noopLogger,
      minEditIntervalMs: 0,
    });

    await reporter.start();

    reporter.onProgress(
      progressEvent('assistant_thinking_delta', {
        delta: '**Plan**',
        contentIndex: 0,
      }),
    );

    reporter.onProgress({
      runId: 'run-thinking-format',
      threadKey: 'telegram:chat:101',
      source: 'telegram',
      deliveryMode: 'followUp',
      timestamp: new Date(0).toISOString(),
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'read',
      args: { path: '/tmp/__pycache__/module.py' },
    });

    await reporter.finishSucceeded();

    const latestEdit = editCalls.at(-1);
    expect(latestEdit?.text).toContain('> read path=/tmp/__pycache__/module.py');
    expect(latestEdit?.text).toContain('~ Plan');
    expect(latestEdit?.entities.some((entity) => entity.type === 'bold')).toBe(true);
  });
});

describe('TelegramRunProgressReporter thinking preview formatting', () => {
  test('renders separate thinking lines when content blocks change', () => {
    const reporter = createThinkingReporter();
    const state = reporter as unknown as {
      eventLogLines: string[];
      flushThinkingPreviewToLog: (now?: number) => boolean;
    };

    reporter.onProgress(
      progressEvent('assistant_thinking_delta', {
        delta: '**Confirming commit safety and reading skill**',
        contentIndex: 0,
      }),
    );
    reporter.onProgress(
      progressEvent('assistant_thinking_delta', {
        delta: '**Preparing commit inspection**',
        contentIndex: 1,
      }),
    );

    state.flushThinkingPreviewToLog(Date.now());

    expect(state.eventLogLines).toEqual([
      '~ **Confirming commit safety and reading skill**',
      '~ **Preparing commit inspection**',
    ]);
  });

  test('starts a new thinking line after non-thinking events even when content index stays the same', () => {
    const reporter = createThinkingReporter();
    const state = reporter as unknown as {
      eventLogLines: string[];
      flushThinkingPreviewToLog: (now?: number) => boolean;
    };

    reporter.onProgress(
      progressEvent('assistant_thinking_delta', {
        delta: '**Planning recommendations for AGENTS.md**',
        contentIndex: 0,
      }),
    );
    reporter.onProgress(
      progressEvent('assistant_text_delta', {
        delta: 'tool output streamed elsewhere',
      }),
    );
    reporter.onProgress(
      progressEvent('assistant_thinking_delta', {
        delta: '**Planning to read agents file**',
        contentIndex: 0,
      }),
    );

    state.flushThinkingPreviewToLog(Date.now());

    expect(state.eventLogLines).toEqual([
      '~ **Planning recommendations for AGENTS.md**',
      '~ **Planning to read agents file**',
    ]);
  });

  test('updates the latest thinking line in place for the same content block', () => {
    const reporter = createThinkingReporter();
    const state = reporter as unknown as {
      eventLogLines: string[];
      flushThinkingPreviewToLog: (now?: number) => boolean;
    };

    reporter.onProgress(
      progressEvent('assistant_thinking_delta', {
        delta: '**Confirming commit safety',
        contentIndex: 0,
      }),
    );
    reporter.onProgress(
      progressEvent('assistant_thinking_delta', {
        delta: ' and reading skill**',
        contentIndex: 0,
      }),
    );

    state.flushThinkingPreviewToLog(Date.now());

    expect(state.eventLogLines).toEqual(['~ **Confirming commit safety and reading skill**']);
  });
});

function archiveChunkLines(chunkText: string): string[] {
  const lines = chunkText.split('\n');
  if (lines.length <= 1) {
    return [];
  }

  return lines.slice(1);
}

function createThinkingReporter(): TelegramRunProgressReporter {
  const bot = {
    api: {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      editMessageText: vi.fn(async () => ({ message_id: 1 })),
      sendChatAction: vi.fn(),
      deleteMessage: vi.fn(),
    },
  } as unknown as Bot;

  return new TelegramRunProgressReporter({
    bot,
    chatId: 101,
    runId: 'run-thinking-format',
    logger: noopLogger,
    minEditIntervalMs: 0,
  });
}

function progressEvent(
  type: 'assistant_thinking_delta' | 'assistant_text_delta',
  extra: { delta: string; contentIndex?: number },
): RunProgressEvent {
  const base = {
    runId: 'run-thinking-format',
    threadKey: 'telegram:chat:101',
    source: 'telegram',
    deliveryMode: 'followUp' as const,
    timestamp: new Date(0).toISOString(),
  };

  if (type === 'assistant_text_delta') {
    return {
      ...base,
      type,
      delta: extra.delta,
    };
  }

  return {
    ...base,
    type,
    delta: extra.delta,
    ...(typeof extra.contentIndex === 'number' ? { contentIndex: extra.contentIndex } : {}),
  };
}
