import { describe, expect, test, vi } from 'vitest';

import { PiRunExecutor } from '../src/runtime/pi-executor.js';

describe('PiRunExecutor.cancelThreadRun', () => {
  test('returns cancelled false when a session exists but is idle', async () => {
    const executor = new PiRunExecutor({} as never, {
      workspaceDir: process.cwd(),
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
    const executor = new PiRunExecutor({} as never, {
      workspaceDir: process.cwd(),
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
    const executor = new PiRunExecutor({} as never, {
      workspaceDir: process.cwd(),
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
    const executor = new PiRunExecutor({} as never, {
      workspaceDir: process.cwd(),
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
