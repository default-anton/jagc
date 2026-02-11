import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  cancelThreadRun,
  resetThreadSession,
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
