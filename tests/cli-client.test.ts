import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  cancelThreadRun,
  createTask,
  listTasks,
  resetThreadSession,
  runTaskNow,
  shareThreadSession,
  startOAuthLogin,
  waitForRun,
} from '../src/cli/client.js';
import { oauthOwnerHeaderName } from '../src/shared/api-contracts.js';

describe('waitForRun', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('validates timeout before polling', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(waitForRun('http://127.0.0.1:31415', 'run-1', 0, 500)).rejects.toThrow('invalid timeoutMs: 0');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('validates interval before polling', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(waitForRun('http://127.0.0.1:31415', 'run-1', 10_000, Number.NaN)).rejects.toThrow(
      'invalid intervalMs: NaN',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('startOAuthLogin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('omits owner header when owner key is not provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          attempt_id: 'attempt-1',
          owner_key: 'generated-owner',
          provider: 'openai-codex',
          provider_name: 'OpenAI Codex',
          status: 'running',
          auth: null,
          prompt: null,
          progress_messages: [],
          error: null,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await startOAuthLogin('http://127.0.0.1:31415', 'openai-codex');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:31415/v1/auth/providers/openai-codex/login',
      expect.objectContaining({
        method: 'POST',
        headers: undefined,
      }),
    );
  });

  test('sends owner header when owner key is provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          attempt_id: 'attempt-1',
          owner_key: 'cli:owner',
          provider: 'openai-codex',
          provider_name: 'OpenAI Codex',
          status: 'running',
          auth: null,
          prompt: null,
          progress_messages: [],
          error: null,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await startOAuthLogin('http://127.0.0.1:31415', 'openai-codex', 'cli:owner');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:31415/v1/auth/providers/openai-codex/login',
      expect.objectContaining({
        method: 'POST',
        headers: {
          [oauthOwnerHeaderName]: 'cli:owner',
        },
      }),
    );
  });
});

describe('cancelThreadRun', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('calls thread run cancel endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          thread_key: 'cli:default',
          cancelled: true,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const response = await cancelThreadRun('http://127.0.0.1:31415', 'cli:default');

    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:31415/v1/threads/cli%3Adefault/cancel', {
      method: 'POST',
    });
    expect(response).toEqual({
      thread_key: 'cli:default',
      cancelled: true,
    });
  });
});

describe('resetThreadSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('calls thread session reset endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          thread_key: 'cli:default',
          reset: true,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const response = await resetThreadSession('http://127.0.0.1:31415', 'cli:default');

    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:31415/v1/threads/cli%3Adefault/session', {
      method: 'DELETE',
    });
    expect(response).toEqual({
      thread_key: 'cli:default',
      reset: true,
    });
  });
});

describe('shareThreadSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('calls thread session share endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          thread_key: 'cli:default',
          gist_url: 'https://gist.github.com/test/abc',
          share_url: 'https://pi.dev/session/#abc',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const response = await shareThreadSession('http://127.0.0.1:31415', 'cli:default');

    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:31415/v1/threads/cli%3Adefault/share', {
      method: 'POST',
    });
    expect(response).toEqual({
      thread_key: 'cli:default',
      gist_url: 'https://gist.github.com/test/abc',
      share_url: 'https://pi.dev/session/#abc',
    });
  });
});

describe('task client endpoints', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('createTask calls thread-scoped task endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          task: {
            task_id: 'task-1',
            title: 'Daily plan',
            instructions: 'Prepare plan',
            schedule: {
              kind: 'cron',
              cron: '0 9 * * 1-5',
              once_at: null,
              timezone: 'America/Los_Angeles',
            },
            enabled: true,
            next_run_at: '2026-02-16T17:00:00.000Z',
            creator_thread_key: 'cli:default',
            owner_user_key: null,
            delivery_target: {
              provider: 'cli',
            },
            execution_thread_key: null,
            created_at: '2026-02-15T00:00:00.000Z',
            updated_at: '2026-02-15T00:00:00.000Z',
            last_run_at: null,
            last_run_status: null,
            last_error_message: null,
          },
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const response = await createTask('http://127.0.0.1:31415', 'cli:default', {
      title: 'Daily plan',
      instructions: 'Prepare plan',
      schedule: {
        kind: 'cron',
        cron: '0 9 * * 1-5',
        timezone: 'America/Los_Angeles',
      },
    });

    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:31415/v1/threads/cli%3Adefault/tasks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Daily plan',
        instructions: 'Prepare plan',
        schedule: {
          kind: 'cron',
          cron: '0 9 * * 1-5',
          timezone: 'America/Los_Angeles',
        },
      }),
    });
    expect(response.task.task_id).toBe('task-1');
  });

  test('listTasks and runTaskNow call expected endpoints', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tasks: [],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            task: {
              task_id: 'task-1',
              title: 'Daily plan',
              instructions: 'Prepare plan',
              schedule: {
                kind: 'cron',
                cron: '0 9 * * 1-5',
                once_at: null,
                timezone: 'America/Los_Angeles',
              },
              enabled: true,
              next_run_at: '2026-02-16T17:00:00.000Z',
              creator_thread_key: 'cli:default',
              owner_user_key: null,
              delivery_target: {
                provider: 'cli',
              },
              execution_thread_key: 'cli:task:task-1',
              created_at: '2026-02-15T00:00:00.000Z',
              updated_at: '2026-02-15T00:00:00.000Z',
              last_run_at: null,
              last_run_status: null,
              last_error_message: null,
            },
            task_run: {
              task_run_id: 'task-run-1',
              task_id: 'task-1',
              scheduled_for: '2026-02-15T00:00:00.000Z',
              idempotency_key: 'task:task-1:scheduled_for:2026-02-15T00:00:00.000Z',
              run_id: 'run-1',
              status: 'dispatched',
              error_message: null,
              created_at: '2026-02-15T00:00:00.000Z',
              updated_at: '2026-02-15T00:00:00.000Z',
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );

    const listed = await listTasks('http://127.0.0.1:31415', {
      state: 'enabled',
      threadKey: 'cli:default',
    });
    const runNow = await runTaskNow('http://127.0.0.1:31415', 'task-1');

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:31415/v1/tasks?thread_key=cli%3Adefault&state=enabled',
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:31415/v1/tasks/task-1/run-now', {
      method: 'POST',
    });

    expect(listed.tasks).toEqual([]);
    expect(runNow.task_run.task_run_id).toBe('task-run-1');
  });
});
