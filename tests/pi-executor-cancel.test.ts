import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { PiRunExecutor } from '../src/runtime/pi-executor.js';

describe('PiRunExecutor.cancelThreadRun', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test('returns cancelled false when a session exists but is idle', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-pi-executor-cancel-'));
    tempDirs.push(workspaceDir);

    const executor = new PiRunExecutor({} as never, {
      workspaceDir,
    });

    const abort = vi.fn(async () => undefined);
    setExecutorSession(executor, 'cli:default', {
      isStreaming: false,
      pendingMessageCount: 0,
      abort,
    });

    const result = await executor.cancelThreadRun('cli:default');

    expect(result).toEqual({
      threadKey: 'cli:default',
      cancelled: false,
    });
    expect(abort).not.toHaveBeenCalled();
  });

  test('returns cancelled true and aborts when a session is actively streaming', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-pi-executor-cancel-'));
    tempDirs.push(workspaceDir);

    const executor = new PiRunExecutor({} as never, {
      workspaceDir,
    });

    const abort = vi.fn(async () => undefined);
    setExecutorSession(executor, 'cli:default', {
      isStreaming: true,
      pendingMessageCount: 0,
      abort,
    });

    const result = await executor.cancelThreadRun('cli:default');

    expect(result).toEqual({
      threadKey: 'cli:default',
      cancelled: true,
    });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  test('returns cancelled true when a session has queued follow-up messages', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-pi-executor-cancel-'));
    tempDirs.push(workspaceDir);

    const executor = new PiRunExecutor({} as never, {
      workspaceDir,
    });

    const abort = vi.fn(async () => undefined);
    setExecutorSession(executor, 'cli:default', {
      isStreaming: false,
      pendingMessageCount: 2,
      abort,
    });

    const result = await executor.cancelThreadRun('cli:default');

    expect(result).toEqual({
      threadKey: 'cli:default',
      cancelled: true,
    });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  test('surfaces abort errors with cancellation context', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-pi-executor-cancel-'));
    tempDirs.push(workspaceDir);

    const executor = new PiRunExecutor({} as never, {
      workspaceDir,
    });

    setExecutorSession(executor, 'cli:default', {
      isStreaming: true,
      pendingMessageCount: 0,
      abort: vi.fn(async () => {
        throw new Error('abort failed');
      }),
    });

    await expect(executor.cancelThreadRun('cli:default')).rejects.toThrow(
      'failed to cancel active run for thread cli:default: abort failed',
    );
  });
});

function setExecutorSession(
  executor: PiRunExecutor,
  threadKey: string,
  session: {
    isStreaming: boolean;
    pendingMessageCount: number;
    abort: () => Promise<void>;
  },
): void {
  const sessions = (executor as unknown as { sessions: Map<string, typeof session> }).sessions;
  sessions.set(threadKey, session);
}
