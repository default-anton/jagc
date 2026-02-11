import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';
import {
  OAuthLoginAttemptNotFoundError,
  OAuthLoginInvalidStateError,
  OAuthLoginProviderNotFoundError,
} from '../src/runtime/pi-auth.js';
import { createApp } from '../src/server/app.js';
import type { RunExecutor } from '../src/server/executor.js';
import type { RunScheduler } from '../src/server/scheduler.js';
import { RunService } from '../src/server/service.js';
import { SqliteRunStore } from '../src/server/store.js';
import type { RunOutput, RunRecord } from '../src/shared/run-types.js';
import { useSqliteTestDb } from './helpers/sqlite-test-db.js';

class TestExecutor implements RunExecutor {
  async execute(run: RunRecord): Promise<RunOutput> {
    return {
      type: 'message',
      text: run.inputText,
    };
  }
}

class FailingExecutor implements RunExecutor {
  async execute(): Promise<RunOutput> {
    throw new Error('agent exploded');
  }
}

class FakeAuthService {
  private readonly attempts = new Map<string, FakeOAuthAttempt>();

  getProviderStatuses() {
    return [
      {
        provider: 'openai',
        has_auth: true,
        credential_type: 'api_key' as const,
        oauth_supported: false,
        env_var_hint: 'OPENAI_API_KEY',
        total_models: 2,
        available_models: 2,
      },
      {
        provider: 'openai-codex',
        has_auth: false,
        credential_type: null,
        oauth_supported: true,
        env_var_hint: null,
        total_models: 1,
        available_models: 0,
      },
    ];
  }

  getProviderCatalog() {
    return [
      {
        provider: 'openai',
        has_auth: true,
        credential_type: 'api_key' as const,
        oauth_supported: false,
        env_var_hint: 'OPENAI_API_KEY',
        total_models: 2,
        available_models: 2,
        models: [
          {
            provider: 'openai',
            model_id: 'gpt-4.1',
            name: 'GPT-4.1',
            reasoning: true,
            available: true,
          },
          {
            provider: 'openai',
            model_id: 'gpt-4o-mini',
            name: 'GPT-4o mini',
            reasoning: false,
            available: true,
          },
        ],
      },
      {
        provider: 'openai-codex',
        has_auth: false,
        credential_type: null,
        oauth_supported: true,
        env_var_hint: null,
        total_models: 1,
        available_models: 0,
        models: [
          {
            provider: 'openai-codex',
            model_id: 'gpt-5-codex',
            name: 'GPT-5 Codex',
            reasoning: true,
            available: false,
          },
        ],
      },
    ];
  }

  startOAuthLogin(provider: string, ownerKey: string) {
    if (provider !== 'openai-codex') {
      throw new OAuthLoginProviderNotFoundError(provider);
    }

    const attempt: FakeOAuthAttempt = {
      attempt_id: randomUUID(),
      owner_key: ownerKey,
      provider,
      provider_name: 'ChatGPT Plus/Pro (Codex Subscription)',
      status: 'awaiting_input',
      auth: {
        url: 'https://auth.example/openai-codex',
        instructions: 'Complete sign-in in your browser.',
      },
      prompt: {
        kind: 'manual_code',
        message: 'Paste the authorization code or full redirect URL.',
        placeholder: null,
        allow_empty: false,
      },
      progress_messages: ['Waiting for OAuth callback...'],
      error: null,
    };

    this.attempts.set(attempt.attempt_id, attempt);
    return attempt;
  }

  getOAuthLoginAttempt(attemptId: string, ownerKey: string) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.owner_key !== ownerKey) {
      return null;
    }

    return attempt;
  }

  submitOAuthLoginInput(attemptId: string, ownerKey: string, value: string, _expectedKind?: 'prompt' | 'manual_code') {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.owner_key !== ownerKey) {
      throw new OAuthLoginAttemptNotFoundError(attemptId);
    }

    if (value.trim().length === 0) {
      throw new OAuthLoginInvalidStateError('Input must not be empty for this prompt');
    }

    const updated: FakeOAuthAttempt = {
      ...attempt,
      status: 'succeeded',
      prompt: null,
      progress_messages: [...attempt.progress_messages, 'OAuth login completed.'],
    };

    this.attempts.set(attemptId, updated);
    return updated;
  }

  cancelOAuthLogin(attemptId: string, ownerKey: string) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.owner_key !== ownerKey) {
      throw new OAuthLoginAttemptNotFoundError(attemptId);
    }

    const updated: FakeOAuthAttempt = {
      ...attempt,
      status: 'cancelled',
      prompt: null,
      error: 'OAuth login cancelled',
    };

    this.attempts.set(attemptId, updated);
    return updated;
  }
}

type FakeOAuthAttempt = {
  attempt_id: string;
  owner_key: string;
  provider: string;
  provider_name: string | null;
  status: 'running' | 'awaiting_input' | 'succeeded' | 'failed' | 'cancelled';
  auth: { url: string; instructions: string | null } | null;
  prompt: {
    kind: 'prompt' | 'manual_code';
    message: string;
    placeholder: string | null;
    allow_empty: boolean;
  } | null;
  progress_messages: string[];
  error: string | null;
};

type FakeThreadState = {
  threadKey: string;
  model: { provider: string; modelId: string; name: string | null } | null;
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  supportsThinking: boolean;
  availableThinkingLevels: ('off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh')[];
};

class FakeThreadControlService {
  private readonly byThread = new Map<string, FakeThreadState>();

  async getThreadRuntimeState(threadKey: string) {
    return this.ensure(threadKey);
  }

  async setThreadModel(threadKey: string, provider: string, modelId: string) {
    const state = this.ensure(threadKey);
    state.model = {
      provider,
      modelId,
      name: modelId,
    };

    return state;
  }

  async setThreadThinkingLevel(
    threadKey: string,
    thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
  ) {
    const state = this.ensure(threadKey);
    state.thinkingLevel = thinkingLevel;

    return state;
  }

  async cancelThreadRun(threadKey: string) {
    return {
      threadKey,
      cancelled: true,
    };
  }

  async resetThreadSession(threadKey: string) {
    this.byThread.delete(threadKey);
  }

  async shareThreadSession(threadKey: string) {
    return {
      threadKey,
      gistUrl: `https://gist.github.com/test/${threadKey}`,
      shareUrl: `https://pi.dev/session/#${threadKey}`,
    };
  }

  private ensure(threadKey: string) {
    const existing = this.byThread.get(threadKey);
    if (existing) {
      return existing;
    }

    const state: FakeThreadState = {
      threadKey,
      model: {
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        name: 'GPT-4o mini',
      },
      thinkingLevel: 'medium',
      supportsThinking: true,
      availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    };

    this.byThread.set(threadKey, state);
    return state;
  }
}

const testDb = useSqliteTestDb();

describe('server API', () => {
  test('GET /healthz returns ok', async () => {
    const { app } = await createTestApp(new TestExecutor());

    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });

  test('POST /v1/messages creates a run and GET /v1/runs returns status', async () => {
    const { app } = await createTestApp(new TestExecutor());

    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        source: 'cli',
        thread_key: 'cli:default',
        text: 'ping',
        delivery_mode: 'followUp',
      },
    });

    expect(createResponse.statusCode).toBe(202);
    const created = createResponse.json();
    expect(created.run_id).toBeTypeOf('string');

    const runResponse = await app.inject({
      method: 'GET',
      url: `/v1/runs/${created.run_id}`,
    });

    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json()).toEqual({
      run_id: created.run_id,
      status: 'succeeded',
      output: {
        type: 'message',
        text: 'ping',
      },
      error: null,
    });

    await app.close();
  });

  test('idempotency key deduplicates runs', async () => {
    const { app } = await createTestApp(new TestExecutor());

    const first = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        source: 'cli',
        thread_key: 'cli:default',
        text: 'hello',
        idempotency_key: 'abc-123',
      },
    });

    const second = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        source: 'cli',
        thread_key: 'cli:default',
        text: 'hello',
        idempotency_key: 'abc-123',
      },
    });

    expect(second.json().run_id).toBe(first.json().run_id);

    await app.close();
  });

  test('returns 400 when body/header idempotency keys differ', async () => {
    const { app } = await createTestApp(new TestExecutor());

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        'idempotency-key': 'header-key',
      },
      payload: {
        source: 'cli',
        thread_key: 'cli:default',
        text: 'hello',
        idempotency_key: 'body-key',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'idempotency_key_mismatch',
        message: 'idempotency key in request body does not match Idempotency-Key header',
      },
    });

    await app.close();
  });

  test('GET /v1/runs includes failure details', async () => {
    const { app } = await createTestApp(new FailingExecutor());

    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        source: 'cli',
        thread_key: 'cli:default',
        text: 'ping',
        delivery_mode: 'followUp',
      },
    });

    const runResponse = await app.inject({
      method: 'GET',
      url: `/v1/runs/${createResponse.json().run_id}`,
    });

    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json()).toMatchObject({
      status: 'failed',
      output: null,
      error: { message: 'agent exploded' },
    });

    await app.close();
  });

  test('GET /v1/auth/providers returns 501 without auth service', async () => {
    const { app } = await createTestApp(new TestExecutor());

    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/providers',
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({
      error: {
        code: 'auth_unavailable',
        message: 'auth service is not configured',
      },
    });

    await app.close();
  });

  test('GET /v1/models returns provider catalogs', async () => {
    const { app } = await createTestApp(new TestExecutor(), {
      authService: new FakeAuthService(),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
    });

    expect(response.statusCode).toBe(200);
    const catalog = response.json();
    expect(catalog.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'openai',
          models: expect.arrayContaining([expect.objectContaining({ model_id: 'gpt-4.1' })]),
        }),
      ]),
    );

    await app.close();
  });

  test('auth login endpoints start, inspect and complete OAuth attempt', async () => {
    const { app } = await createTestApp(new TestExecutor(), {
      authService: new FakeAuthService(),
    });

    const startResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/providers/openai-codex/login',
    });

    expect(startResponse.statusCode).toBe(200);
    const started = startResponse.json();
    expect(started.status).toBe('awaiting_input');
    expect(started.owner_key).toEqual(expect.any(String));
    expect(started.prompt).toMatchObject({
      kind: 'manual_code',
    });

    const inspectResponse = await app.inject({
      method: 'GET',
      url: `/v1/auth/logins/${encodeURIComponent(started.attempt_id)}`,
      headers: {
        'x-jagc-auth-owner': started.owner_key,
      },
    });

    expect(inspectResponse.statusCode).toBe(200);
    expect(inspectResponse.json().attempt_id).toBe(started.attempt_id);

    const submitResponse = await app.inject({
      method: 'POST',
      url: `/v1/auth/logins/${encodeURIComponent(started.attempt_id)}/input`,
      headers: {
        'x-jagc-auth-owner': started.owner_key,
      },
      payload: {
        kind: 'manual_code',
        value: 'https://localhost/callback?code=abc',
      },
    });

    expect(submitResponse.statusCode).toBe(200);
    expect(submitResponse.json()).toMatchObject({
      attempt_id: started.attempt_id,
      status: 'succeeded',
      prompt: null,
    });

    await app.close();
  });

  test('auth login attempts are isolated by owner key', async () => {
    const { app } = await createTestApp(new TestExecutor(), {
      authService: new FakeAuthService(),
    });

    const startResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/providers/openai-codex/login',
      headers: {
        'x-jagc-auth-owner': 'cli:owner-a',
      },
    });

    expect(startResponse.statusCode).toBe(200);
    const started = startResponse.json();

    const inspectResponse = await app.inject({
      method: 'GET',
      url: `/v1/auth/logins/${encodeURIComponent(started.attempt_id)}`,
      headers: {
        'x-jagc-auth-owner': 'cli:owner-b',
      },
    });

    expect(inspectResponse.statusCode).toBe(404);
    expect(inspectResponse.json()).toMatchObject({
      error: {
        code: 'auth_login_not_found',
      },
    });

    await app.close();
  });

  test('auth login input returns error for missing attempt', async () => {
    const { app } = await createTestApp(new TestExecutor(), {
      authService: new FakeAuthService(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logins/missing-attempt/input',
      headers: {
        'x-jagc-auth-owner': 'cli:test-owner',
      },
      payload: {
        value: 'code',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: {
        code: 'auth_login_not_found',
      },
    });

    await app.close();
  });

  test('auth login inspect requires owner header', async () => {
    const { app } = await createTestApp(new TestExecutor(), {
      authService: new FakeAuthService(),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/logins/attempt-id',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'invalid_auth_owner_key',
      },
    });

    await app.close();
  });

  test('auth login unexpected errors return 500', async () => {
    const { app } = await createTestApp(new TestExecutor(), {
      authService: {
        getProviderStatuses: () => [],
        getProviderCatalog: () => [],
        startOAuthLogin: () => {
          throw new Error('boom');
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/providers/openai-codex/login',
      headers: {
        'x-jagc-auth-owner': 'cli:owner',
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: {
        code: 'auth_login_internal_error',
      },
    });

    await app.close();
  });

  test('thread model/thinking/cancel/session endpoints return 501 without thread control service', async () => {
    const { app } = await createTestApp(new TestExecutor(), {
      authService: new FakeAuthService(),
    });

    const runtimeResponse = await app.inject({
      method: 'GET',
      url: '/v1/threads/cli%3Adefault/runtime',
    });

    expect(runtimeResponse.statusCode).toBe(501);

    const modelResponse = await app.inject({
      method: 'PUT',
      url: '/v1/threads/cli%3Adefault/model',
      payload: {
        provider: 'openai',
        model_id: 'gpt-4.1',
      },
    });

    expect(modelResponse.statusCode).toBe(501);

    const thinkingResponse = await app.inject({
      method: 'PUT',
      url: '/v1/threads/cli%3Adefault/thinking',
      payload: {
        thinking_level: 'high',
      },
    });

    expect(thinkingResponse.statusCode).toBe(501);

    const cancelResponse = await app.inject({
      method: 'POST',
      url: '/v1/threads/cli%3Adefault/cancel',
    });

    expect(cancelResponse.statusCode).toBe(501);

    const resetResponse = await app.inject({
      method: 'DELETE',
      url: '/v1/threads/cli%3Adefault/session',
    });

    expect(resetResponse.statusCode).toBe(501);

    const shareResponse = await app.inject({
      method: 'POST',
      url: '/v1/threads/cli%3Adefault/share',
    });

    expect(shareResponse.statusCode).toBe(501);

    await app.close();
  });

  test('thread model/thinking/cancel/session endpoints update runtime state', async () => {
    const { app } = await createTestApp(new TestExecutor(), {
      authService: new FakeAuthService(),
      threadControlService: new FakeThreadControlService(),
    });

    const getInitial = await app.inject({
      method: 'GET',
      url: '/v1/threads/cli%3Adefault/runtime',
    });

    expect(getInitial.statusCode).toBe(200);
    expect(getInitial.json()).toMatchObject({
      thread_key: 'cli:default',
      model: { provider: 'openai', model_id: 'gpt-4o-mini' },
      thinking_level: 'medium',
    });

    const setModelResponse = await app.inject({
      method: 'PUT',
      url: '/v1/threads/cli%3Adefault/model',
      payload: {
        provider: 'openai',
        model_id: 'gpt-4.1',
      },
    });

    expect(setModelResponse.statusCode).toBe(200);
    expect(setModelResponse.json()).toMatchObject({
      model: {
        provider: 'openai',
        model_id: 'gpt-4.1',
      },
    });

    const setThinkingResponse = await app.inject({
      method: 'PUT',
      url: '/v1/threads/cli%3Adefault/thinking',
      payload: {
        thinking_level: 'high',
      },
    });

    expect(setThinkingResponse.statusCode).toBe(200);
    expect(setThinkingResponse.json()).toMatchObject({
      thinking_level: 'high',
    });

    const cancelResponse = await app.inject({
      method: 'POST',
      url: '/v1/threads/cli%3Adefault/cancel',
    });

    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json()).toEqual({
      thread_key: 'cli:default',
      cancelled: true,
    });

    const resetResponse = await app.inject({
      method: 'DELETE',
      url: '/v1/threads/cli%3Adefault/session',
    });

    expect(resetResponse.statusCode).toBe(200);
    expect(resetResponse.json()).toEqual({
      thread_key: 'cli:default',
      reset: true,
    });

    const getAfterReset = await app.inject({
      method: 'GET',
      url: '/v1/threads/cli%3Adefault/runtime',
    });

    expect(getAfterReset.statusCode).toBe(200);
    expect(getAfterReset.json()).toMatchObject({
      thread_key: 'cli:default',
      model: { provider: 'openai', model_id: 'gpt-4o-mini' },
      thinking_level: 'medium',
    });

    const shareResponse = await app.inject({
      method: 'POST',
      url: '/v1/threads/cli%3Adefault/share',
    });

    expect(shareResponse.statusCode).toBe(200);
    expect(shareResponse.json()).toEqual({
      thread_key: 'cli:default',
      gist_url: 'https://gist.github.com/test/cli:default',
      share_url: 'https://pi.dev/session/#cli:default',
    });

    await app.close();
  });
});

async function createTestApp(
  runExecutor: RunExecutor,
  options: {
    authService?: Parameters<typeof createApp>[0]['authService'];
    threadControlService?: FakeThreadControlService;
  } = {},
) {
  const runStore = new SqliteRunStore(testDb.database);

  let runService!: RunService;
  const runScheduler: RunScheduler = {
    async start() {},
    async stop() {},
    async enqueue(run) {
      await runService.executeRunById(run.runId);
    },
    async ensureEnqueued() {
      return false;
    },
  };

  runService = new RunService(runStore, runExecutor, runScheduler);
  await runService.init();

  const app = createApp({
    runService,
    authService: options.authService,
    threadControlService: options.threadControlService,
  });
  app.addHook('onClose', async () => {
    await runService.shutdown();
  });

  return {
    app,
    runService,
    runStore,
  };
}
