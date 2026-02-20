import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import type { RequestedSendKind } from '../src/runtime/telegram-send-files-core.js';
import { createTelegramSendFilesToolDefinition } from '../src/runtime/telegram-send-files-tool.js';
import { TelegramBotApiClone } from './helpers/telegram-bot-api-clone.js';
import { telegramTestBotToken as testBotToken } from './helpers/telegram-test-kit.js';

describe('telegram_send_files tool', () => {
  test('is unavailable for non-Telegram thread keys', () => {
    const tool = createTelegramSendFilesToolDefinition({
      workspaceDir: process.cwd(),
      threadKey: 'cli:default',
      botToken: testBotToken,
    });

    expect(tool).toBeNull();
  });

  test('sends a single photo via sendPhoto', async () => {
    await withCloneAndWorkspace(async ({ clone, workspaceDir }) => {
      await writeFile(join(workspaceDir, 'one.jpg'), sampleJpegBytes());

      const result = await runTool({
        clone,
        workspaceDir,
        files: [{ path: 'one.jpg', kind: 'auto' }],
      });

      expect(result.ok).toBe(true);
      expect(result.sent.photos).toBe(1);
      expect(result.sent.photo_groups).toBe(0);
      expect(result.sent.videos).toBe(0);
      expect(result.sent.audios).toBe(0);
      expect(result.sent.documents).toBe(0);

      const methods = clone.getBotCalls().map((call) => call.method);
      expect(methods).toEqual(['sendPhoto']);
    });
  });

  test('sends 2..10 photos via sendMediaGroup', async () => {
    await withCloneAndWorkspace(async ({ clone, workspaceDir }) => {
      for (let index = 0; index < 3; index += 1) {
        await writeFile(join(workspaceDir, `photo-${index}.jpg`), sampleJpegBytes());
      }

      const result = await runTool({
        clone,
        workspaceDir,
        files: [{ path: 'photo-0.jpg' }, { path: 'photo-1.jpg' }, { path: 'photo-2.jpg' }],
      });

      expect(result.ok).toBe(true);
      expect(result.sent.photo_groups).toBe(1);
      expect(result.sent.photos).toBe(3);

      const methods = clone.getBotCalls().map((call) => call.method);
      expect(methods).toEqual(['sendMediaGroup']);
    });
  });

  test('chunks >10 photos into media groups and singleton sendPhoto', async () => {
    await withCloneAndWorkspace(async ({ clone, workspaceDir }) => {
      const files: Array<{ path: string }> = [];
      for (let index = 0; index < 11; index += 1) {
        const name = `photo-${index}.jpg`;
        await writeFile(join(workspaceDir, name), sampleJpegBytes());
        files.push({ path: name });
      }

      const result = await runTool({
        clone,
        workspaceDir,
        files,
      });

      expect(result.ok).toBe(true);
      expect(result.sent.photo_groups).toBe(1);
      expect(result.sent.photos).toBe(11);

      const methods = clone.getBotCalls().map((call) => call.method);
      expect(methods).toEqual(['sendMediaGroup', 'sendPhoto']);
    });
  });

  test.each([
    {
      kind: 'video' as const,
      method: 'sendVideo' as const,
      path: 'clip.mp4',
      bytes: sampleMp4Bytes(),
      counter: 'videos' as const,
    },
    {
      kind: 'audio' as const,
      method: 'sendAudio' as const,
      path: 'song.m4a',
      bytes: sampleAudioBytes(),
      counter: 'audios' as const,
    },
  ])('sends explicit $kind via $method', async ({ kind, method, path, bytes, counter }) => {
    await withCloneAndWorkspace(async ({ clone, workspaceDir }) => {
      await writeFile(join(workspaceDir, path), bytes);

      const result = await runTool({
        clone,
        workspaceDir,
        files: [{ path, kind }],
      });

      expect(result.ok).toBe(true);
      expect(result.sent[counter]).toBe(1);
      expect(result.sent.documents).toBe(0);

      const methods = clone.getBotCalls().map((call) => call.method);
      expect(methods).toEqual([method]);
    });
  });

  test('routes auto files to video/audio only for supported extensions', async () => {
    await withCloneAndWorkspace(async ({ clone, workspaceDir }) => {
      await writeFile(join(workspaceDir, 'clip.mp4'), sampleMp4Bytes());
      await writeFile(join(workspaceDir, 'song.mp3'), sampleAudioBytes());
      await writeFile(join(workspaceDir, 'song.m4a'), sampleAudioBytes());
      await writeFile(join(workspaceDir, 'archive.bin'), 'raw bytes');

      const result = await runTool({
        clone,
        workspaceDir,
        files: [{ path: 'archive.bin' }, { path: 'song.mp3' }, { path: 'clip.mp4' }, { path: 'song.m4a' }],
      });

      expect(result.ok).toBe(true);
      expect(result.sent.videos).toBe(1);
      expect(result.sent.audios).toBe(2);
      expect(result.sent.documents).toBe(1);

      const methods = clone.getBotCalls().map((call) => call.method);
      expect(methods).toEqual(['sendVideo', 'sendAudio', 'sendAudio', 'sendDocument']);
    });
  });

  test('routes auto .m4a input to sendAudio', async () => {
    await withCloneAndWorkspace(async ({ clone, workspaceDir }) => {
      await writeFile(join(workspaceDir, 'voice.m4a'), sampleAudioBytes());

      const result = await runTool({
        clone,
        workspaceDir,
        files: [{ path: 'voice.m4a', kind: 'auto' }],
      });

      expect(result.ok).toBe(true);
      expect(result.sent.audios).toBe(1);
      expect(result.sent.documents).toBe(0);

      const methods = clone.getBotCalls().map((call) => call.method);
      expect(methods).toEqual(['sendAudio']);
    });
  });

  test('sends photos then videos then audios then documents for mixed payload', async () => {
    await withCloneAndWorkspace(async ({ clone, workspaceDir }) => {
      await writeFile(join(workspaceDir, 'a.jpg'), sampleJpegBytes());
      await writeFile(join(workspaceDir, 'clip.mp4'), sampleMp4Bytes());
      await writeFile(join(workspaceDir, 'song.mp3'), sampleAudioBytes());
      await writeFile(join(workspaceDir, 'notes.txt'), 'plain text');

      const result = await runTool({
        clone,
        workspaceDir,
        files: [
          { path: 'notes.txt', kind: 'document' },
          { path: 'song.mp3', kind: 'audio' },
          { path: 'a.jpg', kind: 'auto' },
          { path: 'clip.mp4', kind: 'video' },
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.sent.photos).toBe(1);
      expect(result.sent.videos).toBe(1);
      expect(result.sent.audios).toBe(1);
      expect(result.sent.documents).toBe(1);

      const methods = clone.getBotCalls().map((call) => call.method);
      expect(methods).toEqual(['sendPhoto', 'sendVideo', 'sendAudio', 'sendDocument']);
    });
  });

  test('downgrades unsupported explicit photo input to document with warning', async () => {
    await withCloneAndWorkspace(async ({ clone, workspaceDir }) => {
      await writeFile(join(workspaceDir, 'notes.txt'), 'not-an-image');

      const result = await runTool({
        clone,
        workspaceDir,
        files: [{ path: 'notes.txt', kind: 'photo' }],
      });

      expect(result.ok).toBe(true);
      expect(result.sent.documents).toBe(1);
      expect(result.warnings.some((warning) => warning.includes('downgraded notes.txt to document'))).toBe(true);

      const methods = clone.getBotCalls().map((call) => call.method);
      expect(methods).toEqual(['sendDocument']);
    });
  });

  test('downgrades unsupported explicit audio/video to document with warning', async () => {
    await withCloneAndWorkspace(async ({ clone, workspaceDir }) => {
      await writeFile(join(workspaceDir, 'voice.wav'), 'wav bytes');
      await writeFile(join(workspaceDir, 'movie.mkv'), 'mkv bytes');

      const result = await runTool({
        clone,
        workspaceDir,
        files: [
          { path: 'voice.wav', kind: 'audio' },
          { path: 'movie.mkv', kind: 'video' },
        ],
      });

      expect(result.ok).toBe(true);
      expect(result.sent.documents).toBe(2);
      expect(result.warnings.some((warning) => warning.includes('voice.wav') && warning.includes('audio'))).toBe(true);
      expect(result.warnings.some((warning) => warning.includes('movie.mkv') && warning.includes('video'))).toBe(true);

      const methods = clone.getBotCalls().map((call) => call.method);
      expect(methods).toEqual(['sendDocument', 'sendDocument']);
    });
  });

  test('returns file_unreadable when file cannot be opened for mime detection', async () => {
    await withCloneAndWorkspace(async ({ clone, workspaceDir }) => {
      const unreadablePath = join(workspaceDir, 'unreadable.jpg');
      await writeFile(unreadablePath, sampleJpegBytes());
      await chmod(unreadablePath, 0o000);

      try {
        const result = await runTool({
          clone,
          workspaceDir,
          files: [{ path: 'unreadable.jpg', kind: 'auto' }],
        });

        expect(result.ok).toBe(false);
        expect(result.error_code).toBe('file_unreadable');
        expect(result.error_message).toContain('unreadable.jpg');
        expect(clone.getBotCalls()).toHaveLength(0);
      } finally {
        await chmod(unreadablePath, 0o600);
      }
    });
  });

  test('honors caption_mode first_only across full outgoing order', async () => {
    await withCloneAndWorkspace(async ({ clone, workspaceDir }) => {
      await writeFile(join(workspaceDir, 'a.jpg'), sampleJpegBytes());
      await writeFile(join(workspaceDir, 'clip.mp4'), sampleMp4Bytes());
      await writeFile(join(workspaceDir, 'notes.txt'), 'plain text');

      const result = await runTool({
        clone,
        workspaceDir,
        captionMode: 'first_only',
        files: [
          { path: 'notes.txt', kind: 'document', caption: 'document caption' },
          { path: 'clip.mp4', kind: 'video', caption: 'video caption' },
          { path: 'a.jpg', kind: 'auto', caption: 'photo caption' },
        ],
      });

      expect(result.ok).toBe(true);

      const calls = clone.getBotCalls();
      expect(calls.map((call) => call.method)).toEqual(['sendPhoto', 'sendVideo', 'sendDocument']);
      expect(calls[0]?.payload.caption).toBe('photo caption');
      expect(calls[1]?.payload.caption).toBeUndefined();
      expect(calls[2]?.payload.caption).toBeUndefined();
    });
  });

  test.each([
    {
      method: 'sendVideo' as const,
      kind: 'video' as const,
      path: 'retry.mp4',
      bytes: sampleMp4Bytes(),
      counter: 'videos' as const,
    },
    {
      method: 'sendAudio' as const,
      kind: 'audio' as const,
      path: 'retry.m4a',
      bytes: sampleAudioBytes(),
      counter: 'audios' as const,
    },
  ])('retries retry_after responses for $method and succeeds', async ({ method, kind, path, bytes, counter }) => {
    await withCloneAndWorkspace(async ({ clone, workspaceDir }) => {
      await writeFile(join(workspaceDir, path), bytes);

      clone.failNextApiCall(method, {
        errorCode: 429,
        description: 'Too Many Requests: retry later',
        parameters: {
          retry_after: 0.05,
        },
      });

      const result = await runTool({
        clone,
        workspaceDir,
        files: [{ path, kind }],
      });

      expect(result.ok).toBe(true);
      expect(result.sent[counter]).toBe(1);
      expect(clone.getApiCallCount(method)).toBeGreaterThanOrEqual(2);
    });
  });
});

async function withCloneAndWorkspace(
  run: (ctx: { clone: TelegramBotApiClone; workspaceDir: string }) => Promise<void>,
): Promise<void> {
  const clone = new TelegramBotApiClone({ token: testBotToken });
  const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-telegram-send-files-test-'));

  try {
    await clone.start();
    await run({ clone, workspaceDir });
  } finally {
    await clone.stop();
    await rm(workspaceDir, { recursive: true, force: true });
  }
}

async function runTool(input: {
  clone: TelegramBotApiClone;
  workspaceDir: string;
  files: Array<{
    path: string;
    kind?: RequestedSendKind;
    caption?: string;
  }>;
  captionMode?: 'per_file' | 'first_only';
}) {
  const tool = createTelegramSendFilesToolDefinition({
    workspaceDir: input.workspaceDir,
    threadKey: 'telegram:chat:101',
    botToken: testBotToken,
    telegramApiRoot: input.clone.apiRoot ?? undefined,
  });

  if (!tool) {
    throw new Error('telegram tool was not created');
  }

  const response = await tool.execute(
    'call-1',
    {
      files: input.files,
      ...(input.captionMode ? { caption_mode: input.captionMode } : {}),
    } as never,
    undefined,
    undefined,
    {} as never,
  );

  return response.details as {
    ok: boolean;
    warnings: string[];
    error_code?: string;
    error_message?: string;
    sent: {
      photo_groups: number;
      photos: number;
      videos: number;
      audios: number;
      documents: number;
    };
  };
}

function sampleJpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x01, 0x02, 0x03, 0xff, 0xd9]);
}

function sampleMp4Bytes(): Buffer {
  return Buffer.from('mp4 sample bytes');
}

function sampleAudioBytes(): Buffer {
  return Buffer.from('audio sample bytes');
}
