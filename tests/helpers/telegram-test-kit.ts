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
  readonly cancelCalls: string[] = [];
  readonly resetCalls: string[] = [];
  readonly shareCalls: string[] = [];
  cancelResult = true;

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

  async cancelThreadRun(threadKey: string): Promise<{ threadKey: string; cancelled: boolean }> {
    this.cancelCalls.push(threadKey);
    return {
      threadKey,
      cancelled: this.cancelResult,
    };
  }

  async resetThreadSession(threadKey: string): Promise<void> {
    this.resetCalls.push(threadKey);
  }

  async shareThreadSession(threadKey: string): Promise<{ threadKey: string; gistUrl: string; shareUrl: string }> {
    this.shareCalls.push(threadKey);
    return {
      threadKey,
      gistUrl: `https://gist.github.com/test/${encodeURIComponent(threadKey)}`,
      shareUrl: `https://pi.dev/session/#${encodeURIComponent(threadKey)}`,
    };
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
    allowedTelegramUserIds?: string[];
    workspaceDir?: string;
    pollIntervalMs?: number;
    pollRequestTimeoutSeconds?: number;
  },
  run: (context: { clone: TelegramBotApiClone; adapter: TelegramPollingAdapter }) => Promise<void>,
): Promise<void> {
  const clone = new TelegramBotApiClone({ token: telegramTestBotToken });
  let adapter: TelegramPollingAdapter | null = null;

  try {
    await clone.start();

    adapter = new TelegramPollingAdapter({
      botToken: telegramTestBotToken,
      runService: options.runService ?? createRunServiceStub(),
      authService: options.authService,
      threadControlService: options.threadControlService,
      allowedTelegramUserIds: options.allowedTelegramUserIds ?? [String(telegramTestUserId)],
      workspaceDir: options.workspaceDir,
      telegramApiRoot: clone.apiRoot ?? undefined,
      pollRequestTimeoutSeconds: options.pollRequestTimeoutSeconds ?? 1,
      pollIntervalMs: options.pollIntervalMs ?? 10,
    });

    await adapter.start();
    await run({ clone, adapter });
  } finally {
    if (adapter) {
      try {
        await adapter.stop();
      } finally {
        await clone.stop();
      }
    } else {
      await clone.stop();
    }
  }
}
