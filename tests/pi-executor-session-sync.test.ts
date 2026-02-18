import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { PiRunExecutor } from '../src/runtime/pi-executor.js';
import type { RunRecord } from '../src/shared/run-types.js';

describe('PiRunExecutor.execute session persistence', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test('upserts the current session mapping after each run', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-pi-executor-session-sync-'));
    tempDirs.push(workspaceDir);

    const runStore = {
      upsertThreadSession: vi.fn(async () => ({
        threadKey: 'cli:default',
        sessionId: 'session-new',
        sessionFile: '/tmp/session-new.jsonl',
      })),
    };

    const executor = new PiRunExecutor(runStore as never, {
      workspaceDir,
    });

    const session = {
      sessionId: 'session-old',
      sessionFile: '/tmp/session-old.jsonl',
    };
    setExecutorSession(executor, 'cli:default', session);

    const submit = vi.fn(async () => {
      session.sessionId = 'session-new';
      session.sessionFile = '/tmp/session-new.jsonl';
      return { type: 'message', text: 'ok' };
    });

    setExecutorController(executor, submit);

    const output = await executor.execute(createRunRecord());

    expect(output).toEqual({ type: 'message', text: 'ok' });
    expect(runStore.upsertThreadSession).toHaveBeenCalledWith('cli:default', 'session-new', '/tmp/session-new.jsonl');
  });

  test('still reconciles session mapping when run execution fails', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-pi-executor-session-sync-'));
    tempDirs.push(workspaceDir);

    const runStore = {
      upsertThreadSession: vi.fn(async () => ({
        threadKey: 'cli:default',
        sessionId: 'session-current',
        sessionFile: '/tmp/session-current.jsonl',
      })),
    };

    const executor = new PiRunExecutor(runStore as never, {
      workspaceDir,
    });

    setExecutorSession(executor, 'cli:default', {
      sessionId: 'session-current',
      sessionFile: '/tmp/session-current.jsonl',
    });

    setExecutorController(
      executor,
      vi.fn(async () => {
        throw new Error('run failed');
      }),
    );

    await expect(executor.execute(createRunRecord())).rejects.toThrow('run failed');
    expect(runStore.upsertThreadSession).toHaveBeenCalledWith(
      'cli:default',
      'session-current',
      '/tmp/session-current.jsonl',
    );
  });

  test('skips stale upsert when thread generation changes during run execution', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'jagc-pi-executor-session-sync-'));
    tempDirs.push(workspaceDir);

    const runStore = {
      upsertThreadSession: vi.fn(async () => ({
        threadKey: 'cli:default',
        sessionId: 'session-current',
        sessionFile: '/tmp/session-current.jsonl',
      })),
    };

    const executor = new PiRunExecutor(runStore as never, {
      workspaceDir,
    });

    setExecutorSession(executor, 'cli:default', {
      sessionId: 'session-current',
      sessionFile: '/tmp/session-current.jsonl',
    });

    setExecutorController(
      executor,
      vi.fn(async () => {
        bumpThreadGeneration(executor, 'cli:default');
        return { type: 'message', text: 'ok' };
      }),
    );

    const output = await executor.execute(createRunRecord());

    expect(output).toEqual({ type: 'message', text: 'ok' });
    expect(runStore.upsertThreadSession).not.toHaveBeenCalled();
  });
});

function setExecutorController(
  executor: PiRunExecutor,
  submit: (run: RunRecord) => Promise<Record<string, unknown>>,
): void {
  const getController = vi.fn(async () => ({ submit }));
  (executor as unknown as { getController: typeof getController }).getController = getController;
}

function setExecutorSession(
  executor: PiRunExecutor,
  threadKey: string,
  session: {
    sessionId: string;
    sessionFile: string;
  },
): void {
  const sessions = (executor as unknown as { sessions: Map<string, typeof session> }).sessions;
  sessions.set(threadKey, session);
}

function bumpThreadGeneration(executor: PiRunExecutor, threadKey: string): void {
  const generationMap = (executor as unknown as { threadGeneration: Map<string, number> }).threadGeneration;
  generationMap.set(threadKey, (generationMap.get(threadKey) ?? 0) + 1);
}

function createRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1',
    source: 'api',
    threadKey: 'cli:default',
    userKey: null,
    deliveryMode: 'followUp',
    status: 'running',
    inputText: 'hello',
    output: null,
    errorMessage: null,
    createdAt: '2026-02-12T00:00:00.000Z',
    updatedAt: '2026-02-12T00:00:00.000Z',
    ...overrides,
  };
}
