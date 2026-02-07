import { setTimeout as sleep } from 'node:timers/promises';

import { type RunnerHandle, run } from '@grammyjs/runner';
import { Bot, type Context } from 'grammy';
import type { ProviderCatalogEntry } from '../runtime/pi-auth.js';
import {
  type SupportedThinkingLevel,
  supportedThinkingLevels,
  type ThreadControlService,
  type ThreadRuntimeState,
} from '../runtime/pi-executor.js';
import type { RunService } from '../server/service.js';
import type { RunRecord } from '../shared/run-types.js';

const defaultWaitTimeoutMs = 180_000;
const defaultPollIntervalMs = 500;
const telegramMessageLimit = 3500;

interface TelegramPollingAdapterOptions {
  botToken: string;
  runService: RunService;
  authService?: {
    getProviderCatalog(): ProviderCatalogEntry[];
  };
  threadControlService?: ThreadControlService;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

interface ParsedTelegramCommand {
  command: string;
  args: string;
}

export class TelegramPollingAdapter {
  private readonly bot: Bot;
  private runner: RunnerHandle | null = null;
  private readonly waitTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: TelegramPollingAdapterOptions) {
    this.bot = new Bot(options.botToken);
    this.waitTimeoutMs = options.waitTimeoutMs ?? defaultWaitTimeoutMs;
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;

    this.bot.catch((error) => {
      console.error(
        JSON.stringify({
          event: 'telegram_handler_error',
          message: error.error instanceof Error ? error.error.message : String(error.error),
        }),
      );
    });

    this.bot.on('message:text', async (ctx) => {
      await this.handleTextMessage(ctx);
    });
  }

  async start(): Promise<void> {
    if (this.runner) {
      return;
    }

    await this.bot.init();
    this.runner = run(this.bot, {
      runner: {
        fetch: {
          allowed_updates: ['message'],
          timeout: 30,
        },
      },
    });

    void this.runner.task()?.catch((error) => {
      console.error(
        JSON.stringify({
          event: 'telegram_runner_stopped_with_error',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });

    const username = this.bot.botInfo.username;
    console.info(JSON.stringify({ event: 'telegram_polling_started', username }));
  }

  async stop(): Promise<void> {
    if (!this.runner) {
      return;
    }

    await this.runner.stop();
    this.runner = null;
    console.info(JSON.stringify({ event: 'telegram_polling_stopped' }));
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    if (!ctx.chat || ctx.chat.type !== 'private') {
      await ctx.reply('Telegram adapter currently supports personal chats only.');
      return;
    }

    const text = ctx.message?.text?.trim();
    if (!text) {
      return;
    }

    const command = parseTelegramCommand(text);
    if (command) {
      await this.handleCommand(ctx, command);
      return;
    }

    await this.handleAssistantMessage(ctx, text, 'followUp');
  }

  private async handleCommand(ctx: Context, command: ParsedTelegramCommand): Promise<void> {
    switch (command.command) {
      case 'start':
      case 'help': {
        await ctx.reply(helpText());
        return;
      }
      case 'model': {
        await this.handleModelCommand(ctx, command.args);
        return;
      }
      case 'thinking': {
        await this.handleThinkingCommand(ctx, command.args);
        return;
      }
      case 'steer': {
        await this.handleAssistantMessage(ctx, command.args.trim(), 'steer');
        return;
      }
      default: {
        await ctx.reply(`Unknown command: /${command.command}`);
      }
    }
  }

  private async handleAssistantMessage(ctx: Context, text: string, deliveryMode: 'steer' | 'followUp'): Promise<void> {
    const prompt = text.trim();
    if (!prompt) {
      await ctx.reply('Message is empty.');
      return;
    }

    const threadKey = telegramThreadKey(ctx.chat?.id);
    const userKey = telegramUserKey(ctx.from?.id);

    const ingested = await this.options.runService.ingestMessage({
      source: 'telegram',
      threadKey,
      userKey,
      text: prompt,
      deliveryMode,
      idempotencyKey: `telegram:update:${ctx.update.update_id}`,
    });

    const completedRun = await this.waitForCompletion(ingested.run.runId);
    if (completedRun.status === 'running') {
      await ctx.reply(`Run queued as ${completedRun.runId}. Still running.`);
      return;
    }

    await this.replyLong(ctx, formatRunResult(completedRun));
  }

  private async handleModelCommand(ctx: Context, args: string): Promise<void> {
    const threadControlService = this.options.threadControlService;
    if (!threadControlService) {
      await ctx.reply('Model controls are unavailable when JAGC_RUNNER is not pi.');
      return;
    }

    const threadKey = telegramThreadKey(ctx.chat?.id);
    const trimmed = args.trim();

    if (!trimmed || trimmed === 'get') {
      const state = await threadControlService.getThreadRuntimeState(threadKey);
      await ctx.reply(formatModelState(state));
      return;
    }

    if (trimmed === 'list' || trimmed.startsWith('list ')) {
      const authService = this.options.authService;
      if (!authService) {
        await ctx.reply('Model catalog is unavailable.');
        return;
      }

      const filter = trimmed.slice('list'.length).trim();
      const providers = authService
        .getProviderCatalog()
        .filter((provider) => (filter ? provider.provider === filter : true));

      if (providers.length === 0) {
        await ctx.reply(filter ? `No provider named "${filter}".` : 'No providers available.');
        return;
      }

      const lines: string[] = [];
      for (const provider of providers) {
        lines.push(`${provider.provider} (${provider.available_models}/${provider.total_models})`);
        for (const model of provider.models) {
          const marker = model.available ? '✅' : '◻️';
          const reasoning = model.reasoning ? ' 🧠' : '';
          lines.push(`  ${marker} ${model.model_id}${reasoning}`);
        }
      }

      await this.replyLong(ctx, lines.join('\n'));
      return;
    }

    const parsed = parseProviderModel(trimmed);
    const state = await threadControlService.setThreadModel(threadKey, parsed.provider, parsed.modelId);
    if (!state.model) {
      await ctx.reply('Model cleared for this thread.');
      return;
    }

    await ctx.reply(`Model set to ${state.model.provider}/${state.model.modelId}`);
  }

  private async handleThinkingCommand(ctx: Context, args: string): Promise<void> {
    const threadControlService = this.options.threadControlService;
    if (!threadControlService) {
      await ctx.reply('Thinking controls are unavailable when JAGC_RUNNER is not pi.');
      return;
    }

    const threadKey = telegramThreadKey(ctx.chat?.id);
    const trimmed = args.trim();

    if (!trimmed || trimmed === 'get') {
      const state = await threadControlService.getThreadRuntimeState(threadKey);
      await ctx.reply(formatThinkingState(state));
      return;
    }

    if (trimmed === 'list') {
      const state = await threadControlService.getThreadRuntimeState(threadKey);
      await ctx.reply(`Thinking levels: ${state.availableThinkingLevels.join(', ')}`);
      return;
    }

    if (!isSupportedThinkingLevel(trimmed)) {
      await ctx.reply(`Invalid thinking level. Use one of: ${supportedThinkingLevels.join(', ')}`);
      return;
    }

    const state = await threadControlService.setThreadThinkingLevel(threadKey, trimmed);
    await ctx.reply(`Thinking level set to ${state.thinkingLevel}`);
  }

  private async waitForCompletion(runId: string): Promise<RunRecord> {
    const startedAt = Date.now();

    while (true) {
      const run = await this.options.runService.getRun(runId);
      if (!run) {
        throw new Error(`run ${runId} not found while waiting for completion`);
      }

      if (run.status !== 'running') {
        return run;
      }

      if (Date.now() - startedAt >= this.waitTimeoutMs) {
        return run;
      }

      await sleep(this.pollIntervalMs);
    }
  }

  private async replyLong(ctx: Context, text: string): Promise<void> {
    for (const chunk of chunkMessage(text, telegramMessageLimit)) {
      await ctx.reply(chunk);
    }
  }
}

export function parseTelegramCommand(text: string): ParsedTelegramCommand | null {
  const match = text.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!match) {
    return null;
  }

  return {
    command: match[1]?.toLowerCase() ?? '',
    args: match[2] ?? '',
  };
}

function parseProviderModel(value: string): { provider: string; modelId: string } {
  const separatorIndex = value.indexOf('/');

  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error('Expected model in provider/model format, e.g. openai/gpt-5');
  }

  return {
    provider: value.slice(0, separatorIndex),
    modelId: value.slice(separatorIndex + 1),
  };
}

function formatRunResult(run: RunRecord): string {
  if (run.status === 'failed') {
    return `❌ ${run.errorMessage ?? 'run failed'}`;
  }

  if (!run.output) {
    return 'Run succeeded with no output.';
  }

  const messageText = run.output.text;
  if (typeof messageText === 'string' && messageText.trim().length > 0) {
    return messageText;
  }

  return `Run output:\n${JSON.stringify(run.output, null, 2)}`;
}

function formatModelState(state: ThreadRuntimeState): string {
  const model = state.model ? `${state.model.provider}/${state.model.modelId}` : '(none)';
  const available = state.availableThinkingLevels.join(', ');

  return [
    `Model: ${model}`,
    `Thinking: ${state.thinkingLevel}`,
    `Available thinking levels: ${available}`,
    'Usage: /model list [provider] | /model <provider/model>',
  ].join('\n');
}

function formatThinkingState(state: ThreadRuntimeState): string {
  return [`Thinking: ${state.thinkingLevel}`, `Levels: ${state.availableThinkingLevels.join(', ')}`].join('\n');
}

function helpText(): string {
  return [
    'jagc Telegram commands:',
    '/model — show current model',
    '/model list [provider] — list providers and models',
    '/model <provider/model> — set model for this chat thread',
    '/thinking — show current thinking level',
    '/thinking list — list available thinking levels',
    '/thinking <level> — set thinking level for this chat thread',
    '/steer <message> — send an interrupting message (explicit steer)',
  ].join('\n');
}

function chunkMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > maxLength) {
    const breakIndex = rest.lastIndexOf('\n', maxLength);
    const splitIndex = breakIndex > maxLength / 3 ? breakIndex : maxLength;

    chunks.push(rest.slice(0, splitIndex));
    rest = rest.slice(splitIndex).trimStart();
  }

  if (rest.length > 0) {
    chunks.push(rest);
  }

  return chunks;
}

function telegramThreadKey(chatId: number | undefined): string {
  if (chatId === undefined) {
    throw new Error('telegram message has no chat id');
  }

  return `telegram:chat:${chatId}`;
}

function telegramUserKey(userId: number | undefined): string | undefined {
  if (userId === undefined) {
    return undefined;
  }

  return `telegram:user:${userId}`;
}

function isSupportedThinkingLevel(value: string): value is SupportedThinkingLevel {
  return supportedThinkingLevels.includes(value as SupportedThinkingLevel);
}
