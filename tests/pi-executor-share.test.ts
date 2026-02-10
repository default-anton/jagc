import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

interface SpawnPlan {
  code: number;
  stdout?: string;
  stderr?: string;
  error?: NodeJS.ErrnoException;
}

const { spawnMock, spawnPlans, spawnCalls } = vi.hoisted(() => {
  const plans: SpawnPlan[] = [];
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> | undefined }> = [];

  const mock = vi.fn((command: string, args: string[], options?: Record<string, unknown>) => {
    const plan = plans.shift();
    if (!plan) {
      throw new Error(`missing spawn plan for ${command} ${args.join(' ')}`);
    }

    calls.push({ command, args, options });

    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: (encoding: string) => void };
      stderr: EventEmitter & { setEncoding: (encoding: string) => void };
      kill: (signal?: NodeJS.Signals) => boolean;
    };

    const stdout = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
    const stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };

    stdout.setEncoding = vi.fn();
    stderr.setEncoding = vi.fn();

    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = vi.fn(() => true);

    queueMicrotask(() => {
      if (plan.error) {
        child.emit('error', plan.error);
      }

      if (plan.stdout) {
        stdout.emit('data', plan.stdout);
      }

      if (plan.stderr) {
        stderr.emit('data', plan.stderr);
      }

      child.emit('close', plan.code);
    });

    return child;
  });

  return {
    spawnMock: mock,
    spawnPlans: plans,
    spawnCalls: calls,
  };
});

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { PiRunExecutor } from '../src/runtime/pi-executor.js';

describe('PiRunExecutor.shareThreadSession', () => {
  beforeEach(() => {
    spawnPlans.length = 0;
    spawnCalls.length = 0;
    spawnMock.mockClear();
  });

  afterEach(() => {
    delete process.env.PI_SHARE_VIEWER_URL;
  });

  test('validates PI_SHARE_VIEWER_URL before loading thread session', async () => {
    process.env.PI_SHARE_VIEWER_URL = 'not-a-url';
    spawnPlans.push({ code: 0 });

    const executor = new PiRunExecutor({} as never, {
      workspaceDir: process.cwd(),
    });

    const getSession = vi.fn();
    (executor as unknown as { getSession: typeof getSession }).getSession = getSession;

    await expect(executor.shareThreadSession('cli:default')).rejects.toThrow(
      'PI_SHARE_VIEWER_URL must be an absolute URL. Received: not-a-url',
    );

    expect(getSession).not.toHaveBeenCalled();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      command: 'gh',
      args: ['auth', 'status'],
    });
  });

  test('creates secret gist and builds share URL hash from gist ID', async () => {
    process.env.PI_SHARE_VIEWER_URL = 'https://viewer.example/session?source=test';

    spawnPlans.push({ code: 0 });
    spawnPlans.push({ code: 0, stdout: 'https://gist.github.com/test/abc123\n' });

    const executor = new PiRunExecutor({} as never, {
      workspaceDir: process.cwd(),
    });

    const exportToHtml = vi.fn(async (path: string) => {
      await writeFile(path, '<html><body>shared</body></html>', 'utf8');
    });

    (executor as unknown as { getSession: () => Promise<{ exportToHtml: typeof exportToHtml }> }).getSession = vi.fn(
      async () => ({
        exportToHtml,
      }),
    );

    const result = await executor.shareThreadSession('cli:default');

    expect(result).toEqual({
      threadKey: 'cli:default',
      gistUrl: 'https://gist.github.com/test/abc123',
      shareUrl: 'https://viewer.example/session?source=test#abc123',
    });

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]).toMatchObject({
      command: 'gh',
      args: ['auth', 'status'],
      options: {
        env: expect.objectContaining({
          GH_PROMPT_DISABLED: '1',
        }),
      },
    });
    expect(spawnCalls[1]).toMatchObject({
      command: 'gh',
      args: ['gist', 'create', expect.any(String)],
      options: {
        env: expect.objectContaining({
          GH_PROMPT_DISABLED: '1',
        }),
      },
    });

    expect(exportToHtml).toHaveBeenCalledTimes(1);
  });
});
