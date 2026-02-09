import { TelegramPollingAdapter } from '../../src/adapters/telegram-polling.js';
import type { ThreadControlService, ThreadRuntimeState } from '../../src/runtime/pi-executor.js';
import type { RunService } from '../../src/server/service.js';
import { TelegramBotApiClone } from './telegram-bot-api-clone.js';

export const telegramTestBotToken = '123456:TESTTOKEN';
export const telegramTestChatId = 101;
export const telegramTestUserId = 202;

type TelegramPollingAdapterOptions = ConstructorParameters<typeof TelegramPollingAdapter>[0];

export type TelegramAdapterAuthService = NonNullable<TelegramPollingAdapterOptions['authService']>;

export class FakeThreadControlService implements ThreadControlService {
  readonly modelSetCalls: Array<{ threadKey: string; provider: string; modelId: string }> = [];
  readonly thinkingSetCalls: Array<{ threadKey: string; thinkingLevel: ThreadRuntimeState['thinkingLevel'] }> = [];
  readonly resetCalls: string[] = [];

  constructor(private state: ThreadRuntimeState) {}

  async getThreadRuntimeState(): Promise<ThreadRuntimeState> {
    return this.state;
  }

  async setThreadModel(threadKey: string, provider: string, modelId: string): Promise<ThreadRuntimeState> {
    this.modelSetCalls.push({ threadKey, provider, modelId });
    this.state = {
      ...this.state,
      model: {
        provider,
        modelId,
        name: modelId,
      },
    };

    return this.state;
  }

  async setThreadThinkingLevel(
    threadKey: string,
    thinkingLevel: ThreadRuntimeState['thinkingLevel'],
  ): Promise<ThreadRuntimeState> {
    this.thinkingSetCalls.push({ threadKey, thinkingLevel });
    this.state = {
      ...this.state,
      thinkingLevel,
    };

    return this.state;
  }

  async resetThreadSession(threadKey: string): Promise<void> {
    this.resetCalls.push(threadKey);
  }
}

export function createThreadRuntimeState(overrides: Partial<ThreadRuntimeState> = {}): ThreadRuntimeState {
  return {
    threadKey: 'telegram:chat:101',
    model: {
      provider: 'openai',
      modelId: 'gpt-5',
      name: 'GPT-5',
    },
    thinkingLevel: 'medium',
    supportsThinking: true,
    availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    ...overrides,
  };
}

export function createRunServiceStub(): RunService {
  return {
    async ingestMessage() {
      throw new Error('not implemented in this test');
    },
    async getRun() {
      throw new Error('not implemented in this test');
    },
  } as unknown as RunService;
}

export async function withTelegramAdapter(
  options: {
    runService?: RunService;
    authService?: TelegramAdapterAuthService;
    threadControlService?: ThreadControlService;
    waitTimeoutMs?: number;
    pollIntervalMs?: number;
    pollRequestTimeoutSeconds?: number;
  },
  run: (context: { clone: TelegramBotApiClone; adapter: TelegramPollingAdapter }) => Promise<void>,
): Promise<void> {
  const clone = new TelegramBotApiClone({ token: telegramTestBotToken });
  await clone.start();

  const adapter = new TelegramPollingAdapter({
    botToken: telegramTestBotToken,
    runService: options.runService ?? createRunServiceStub(),
    authService: options.authService,
    threadControlService: options.threadControlService,
    telegramApiRoot: clone.apiRoot ?? undefined,
    pollRequestTimeoutSeconds: options.pollRequestTimeoutSeconds ?? 1,
    waitTimeoutMs: options.waitTimeoutMs,
    pollIntervalMs: options.pollIntervalMs ?? 10,
  });

  await adapter.start();

  try {
    await run({ clone, adapter });
  } finally {
    await adapter.stop();
    await clone.stop();
  }
}
