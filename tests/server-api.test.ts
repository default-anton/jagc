import { describe, expect, test } from 'vitest';

import { createApp } from '../src/server/app.js';
import type { RunExecutor } from '../src/server/executor.js';
import type { RunScheduler } from '../src/server/scheduler.js';
import { RunService } from '../src/server/service.js';
import { InMemoryRunStore } from '../src/server/store.js';
import type { RunOutput, RunRecord } from '../src/shared/run-types.js';

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
    ];
  }
}

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
    expect(response.json()).toMatchObject({
      providers: [
        {
          provider: 'openai',
          models: [{ model_id: 'gpt-4.1' }, { model_id: 'gpt-4o-mini' }],
        },
      ],
    });

    await app.close();
  });

  test('thread model and thinking endpoints return 501 without thread control service', async () => {
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

    await app.close();
  });

  test('thread model and thinking endpoints update runtime state', async () => {
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

    await app.close();
  });
});

async function createTestApp(
  runExecutor: RunExecutor,
  options: {
    authService?: FakeAuthService;
    threadControlService?: FakeThreadControlService;
  } = {},
) {
  const runStore = new InMemoryRunStore();

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
