import type { Bot } from 'grammy';
import { describe, expect, test, vi } from 'vitest';

import { TelegramRunProgressReporter } from '../src/adapters/telegram-progress.js';
import { noopLogger } from '../src/shared/logger.js';

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

function archiveChunkLines(chunkText: string): string[] {
  const lines = chunkText.split('\n');
  if (lines.length <= 1) {
    return [];
  }

  return lines.slice(1);
}
