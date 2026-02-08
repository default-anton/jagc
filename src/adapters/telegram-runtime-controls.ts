import { type Context, InlineKeyboard } from 'grammy';
import type {
  OAuthLoginAttemptSnapshot,
  OAuthLoginInputKind,
  ProviderAuthStatus,
  ProviderCatalogEntry,
} from '../runtime/pi-auth.js';
import type { ThreadControlService, ThreadRuntimeState } from '../runtime/pi-executor.js';
import { TelegramAuthControls } from './telegram-auth-controls.js';
import {
  callbackAuthProviders,
  callbackModelList,
  callbackModelProviders,
  callbackModelSet,
  callbackThinkingSet,
  type TelegramCallbackAction,
} from './telegram-controls-callbacks.js';

const providerPageSize = 8;
const modelPageSize = 8;

interface TelegramRuntimeControlsOptions {
  authService?: {
    getProviderCatalog(): ProviderCatalogEntry[];
    getProviderStatuses?(): ProviderAuthStatus[];
    startOAuthLogin?(provider: string, ownerKey: string): OAuthLoginAttemptSnapshot;
    getOAuthLoginAttempt?(attemptId: string, ownerKey: string): OAuthLoginAttemptSnapshot | null;
    submitOAuthLoginInput?(
      attemptId: string,
      ownerKey: string,
      value: string,
      expectedKind?: OAuthLoginInputKind,
    ): OAuthLoginAttemptSnapshot;
    cancelOAuthLogin?(attemptId: string, ownerKey: string): OAuthLoginAttemptSnapshot;
  };
  threadControlService?: ThreadControlService;
}

export class TelegramRuntimeControls {
  private readonly authControls: TelegramAuthControls;

  constructor(private readonly options: TelegramRuntimeControlsOptions) {
    this.authControls = new TelegramAuthControls({
      authService: options.authService,
    });
  }

  async handleSettingsCommand(ctx: Context): Promise<void> {
    await this.showSettingsPanel(ctx);
  }

  async handleModelCommand(ctx: Context, args: string): Promise<void> {
    const threadControlService = this.options.threadControlService;
    if (!threadControlService) {
      await ctx.reply('Model controls are unavailable when JAGC_RUNNER is not pi.');
      return;
    }

    if (args.trim().length > 0) {
      await ctx.reply('Text arguments for /model are no longer supported. Use the buttons.');
    }

    await this.showModelProviderPicker(ctx, 0);
  }

  async handleThinkingCommand(ctx: Context, args: string): Promise<void> {
    const threadControlService = this.options.threadControlService;
    if (!threadControlService) {
      await ctx.reply('Thinking controls are unavailable when JAGC_RUNNER is not pi.');
      return;
    }

    if (args.trim().length > 0) {
      await ctx.reply('Text arguments for /thinking are no longer supported. Use the buttons.');
    }

    await this.showThinkingPicker(ctx);
  }

  async handleAuthCommand(ctx: Context, args: string): Promise<void> {
    await this.authControls.handleAuthCommand(ctx, args);
  }

  async handleCallbackAction(ctx: Context, action: TelegramCallbackAction): Promise<void> {
    switch (action.kind) {
      case 'settings_open':
      case 'settings_refresh': {
        await this.showSettingsPanel(ctx);
        return;
      }
      case 'auth_open':
      case 'auth_providers':
      case 'auth_login':
      case 'auth_attempt_refresh':
      case 'auth_attempt_cancel': {
        await this.authControls.handleCallbackAction(ctx, action);
        return;
      }
      case 'model_providers': {
        await this.showModelProviderPicker(ctx, action.page);
        return;
      }
      case 'model_list': {
        await this.showModelList(ctx, action.provider, action.page);
        return;
      }
      case 'model_set': {
        await this.setModelFromPicker(ctx, action.provider, action.modelId, action.page);
        return;
      }
      case 'thinking_list': {
        await this.showThinkingPicker(ctx);
        return;
      }
      case 'thinking_set': {
        await this.setThinkingFromPicker(ctx, action.thinkingLevel);
        return;
      }
    }
  }

  private async showSettingsPanel(ctx: Context): Promise<void> {
    const threadControlService = this.options.threadControlService;
    if (!threadControlService) {
      await this.replyUi(
        ctx,
        'Runtime controls are unavailable when JAGC_RUNNER is not pi.',
        new InlineKeyboard().text('ℹ️ Help', 's:open'),
      );
      return;
    }

    const threadKey = telegramThreadKey(ctx.chat?.id);
    const state = await threadControlService.getThreadRuntimeState(threadKey);

    const lines = [
      '⚙️ Runtime settings',
      `Model: ${formatModelValue(state)}`,
      `Thinking: ${state.thinkingLevel}`,
      '',
      'Choose what to change:',
    ];

    await this.replyUi(ctx, lines.join('\n'), settingsKeyboard());
  }

  private async showModelProviderPicker(ctx: Context, requestedPage: number): Promise<void> {
    const threadControlService = this.options.threadControlService;
    const authService = this.options.authService;

    if (!threadControlService) {
      await this.replyUi(ctx, 'Model controls are unavailable when JAGC_RUNNER is not pi.', settingsKeyboard());
      return;
    }

    if (!authService) {
      await this.replyUi(ctx, 'Model catalog is unavailable.', settingsKeyboard());
      return;
    }

    const threadKey = telegramThreadKey(ctx.chat?.id);
    const state = await threadControlService.getThreadRuntimeState(threadKey);

    const providers = authService.getProviderCatalog().filter((provider) => provider.available_models > 0);
    if (providers.length === 0) {
      await this.replyUi(
        ctx,
        [
          '🤖 Model selection',
          `Current: ${formatModelValue(state)}`,
          '',
          'No models are currently available.',
          'Configure provider authentication, then try again.',
        ].join('\n'),
        settingsKeyboard(),
      );
      return;
    }

    const paged = paginate(providers, requestedPage, providerPageSize);

    const lines = [
      '🤖 Model selection',
      `Current: ${formatModelValue(state)}`,
      '',
      `Choose provider (${paged.page + 1}/${paged.totalPages}):`,
    ];

    const keyboard = new InlineKeyboard();
    for (const provider of paged.items) {
      keyboard
        .text(`${provider.provider} (${provider.available_models})`, callbackModelList(provider.provider, 0))
        .row();
    }

    if (paged.totalPages > 1) {
      if (paged.page > 0) {
        keyboard.text('⬅️ Prev', callbackModelProviders(paged.page - 1));
      }
      if (paged.page < paged.totalPages - 1) {
        keyboard.text('Next ➡️', callbackModelProviders(paged.page + 1));
      }
      keyboard.row();
    }

    keyboard.text('⚙️ Settings', 's:open');

    await this.replyUi(ctx, lines.join('\n'), keyboard);
  }

  private async showModelList(
    ctx: Context,
    providerName: string,
    requestedPage: number,
    notice?: string,
  ): Promise<void> {
    const threadControlService = this.options.threadControlService;
    const authService = this.options.authService;

    if (!threadControlService) {
      await this.replyUi(ctx, 'Model controls are unavailable when JAGC_RUNNER is not pi.', settingsKeyboard());
      return;
    }

    if (!authService) {
      await this.replyUi(ctx, 'Model catalog is unavailable.', settingsKeyboard());
      return;
    }

    const provider = authService.getProviderCatalog().find((entry) => entry.provider === providerName);
    if (!provider) {
      await this.replyUi(ctx, 'Provider not found. Use /model to reopen the model picker.', settingsKeyboard());
      return;
    }

    const threadKey = telegramThreadKey(ctx.chat?.id);
    const state = await threadControlService.getThreadRuntimeState(threadKey);

    const availableModels = provider.models.filter((model) => model.available).map((model) => ({ model }));

    if (availableModels.length === 0) {
      await this.replyUi(
        ctx,
        [`🤖 Model selection`, `Provider: ${provider.provider}`, '', 'No available models for this provider.'].join(
          '\n',
        ),
        new InlineKeyboard().text('⬅️ Back to providers', callbackModelProviders(0)).row().text('⚙️ Settings', 's:open'),
      );
      return;
    }

    const paged = paginate(availableModels, requestedPage, modelPageSize);

    const lines: string[] = [];
    if (notice) {
      lines.push(notice, '');
    }

    lines.push(
      '🤖 Model selection',
      `Current: ${formatModelValue(state)}`,
      `Provider: ${provider.provider}`,
      '',
      `Choose model (${paged.page + 1}/${paged.totalPages}):`,
    );

    const keyboard = new InlineKeyboard();
    for (const { model } of paged.items) {
      const selected = state.model?.provider === provider.provider && state.model.modelId === model.model_id;
      const prefix = selected ? '✅' : '◻️';
      const reasoning = model.reasoning ? ' 🧠' : '';
      keyboard
        .text(
          `${prefix} ${model.model_id}${reasoning}`,
          callbackModelSet(provider.provider, model.model_id, paged.page),
        )
        .row();
    }

    if (paged.totalPages > 1) {
      if (paged.page > 0) {
        keyboard.text('⬅️ Prev', callbackModelList(provider.provider, paged.page - 1));
      }
      if (paged.page < paged.totalPages - 1) {
        keyboard.text('Next ➡️', callbackModelList(provider.provider, paged.page + 1));
      }
      keyboard.row();
    }

    keyboard.text('⬅️ Providers', callbackModelProviders(0)).row().text('⚙️ Settings', 's:open');

    await this.replyUi(ctx, lines.join('\n'), keyboard);
  }

  private async setModelFromPicker(ctx: Context, providerName: string, modelId: string, page: number): Promise<void> {
    const threadControlService = this.options.threadControlService;
    const authService = this.options.authService;

    if (!threadControlService || !authService) {
      await this.replyUi(ctx, 'Model controls are unavailable.', settingsKeyboard());
      return;
    }

    const provider = authService.getProviderCatalog().find((entry) => entry.provider === providerName);
    if (!provider) {
      await this.replyUi(ctx, 'Provider not found. Use /model to reopen the model picker.', settingsKeyboard());
      return;
    }

    const selectedModel = provider.models.find((model) => model.available && model.model_id === modelId);
    if (!selectedModel) {
      await this.replyUi(ctx, 'Model option expired. Reopen /model and try again.', settingsKeyboard());
      return;
    }

    const threadKey = telegramThreadKey(ctx.chat?.id);
    await threadControlService.setThreadModel(threadKey, provider.provider, selectedModel.model_id);

    await this.showModelList(
      ctx,
      provider.provider,
      page,
      `✅ Model set to ${provider.provider}/${selectedModel.model_id}`,
    );
  }

  private async showThinkingPicker(ctx: Context, notice?: string): Promise<void> {
    const threadControlService = this.options.threadControlService;
    if (!threadControlService) {
      await this.replyUi(ctx, 'Thinking controls are unavailable when JAGC_RUNNER is not pi.', settingsKeyboard());
      return;
    }

    const threadKey = telegramThreadKey(ctx.chat?.id);
    const state = await threadControlService.getThreadRuntimeState(threadKey);

    const lines: string[] = [];
    if (notice) {
      lines.push(notice, '');
    }

    lines.push(
      '🧠 Thinking level',
      `Current: ${state.thinkingLevel}`,
      '',
      'Higher levels are slower but can improve hard reasoning tasks.',
    );

    const keyboard = new InlineKeyboard();

    const availableLevels = state.availableThinkingLevels;
    if (!state.supportsThinking || availableLevels.length === 0) {
      lines.push('', 'This model does not support configurable thinking levels.');
      keyboard.text('🤖 Change model', callbackModelProviders(0)).row().text('⚙️ Settings', 's:open');
      await this.replyUi(ctx, lines.join('\n'), keyboard);
      return;
    }

    for (let i = 0; i < availableLevels.length; i += 2) {
      const first = availableLevels[i];
      if (!first) {
        continue;
      }

      const firstLabel = first === state.thinkingLevel ? `✅ ${first}` : first;
      keyboard.text(firstLabel, callbackThinkingSet(first));

      const second = availableLevels[i + 1];
      if (second) {
        const secondLabel = second === state.thinkingLevel ? `✅ ${second}` : second;
        keyboard.text(secondLabel, callbackThinkingSet(second));
      }

      keyboard.row();
    }

    keyboard.text('⚙️ Settings', 's:open').row().text('🤖 Change model', callbackModelProviders(0));

    await this.replyUi(ctx, lines.join('\n'), keyboard);
  }

  private async setThinkingFromPicker(ctx: Context, thinkingLevel: string): Promise<void> {
    const threadControlService = this.options.threadControlService;
    if (!threadControlService) {
      await this.replyUi(ctx, 'Thinking controls are unavailable when JAGC_RUNNER is not pi.', settingsKeyboard());
      return;
    }

    const threadKey = telegramThreadKey(ctx.chat?.id);
    const currentState = await threadControlService.getThreadRuntimeState(threadKey);
    const selectedThinkingLevel = currentState.availableThinkingLevels.find((level) => level === thinkingLevel);
    if (!currentState.supportsThinking || !selectedThinkingLevel) {
      await this.showThinkingPicker(ctx, 'Thinking option expired. Reopen /thinking and try again.');
      return;
    }

    const state = await threadControlService.setThreadThinkingLevel(threadKey, selectedThinkingLevel);

    await this.showThinkingPicker(ctx, `✅ Thinking set to ${state.thinkingLevel}`);
  }

  private async replyUi(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
    const options = { reply_markup: keyboard };

    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, options);
        return;
      } catch (error) {
        if (isMessageNotModifiedError(error)) {
          return;
        }
      }
    }

    await ctx.reply(text, options);
  }
}

function settingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🤖 Change model', callbackModelProviders(0))
    .row()
    .text('🧠 Change thinking', 't:list')
    .row()
    .text('🔐 Provider login', callbackAuthProviders(0))
    .row()
    .text('🔄 Refresh', 's:refresh');
}

function formatModelValue(state: ThreadRuntimeState): string {
  if (!state.model) {
    return '(default)';
  }

  return `${state.model.provider}/${state.model.modelId}`;
}

function paginate<T>(
  items: readonly T[],
  requestedPage: number,
  pageSize: number,
): {
  items: T[];
  page: number;
  totalPages: number;
} {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(requestedPage, 0), totalPages - 1);
  const startIndex = page * pageSize;
  const endIndex = startIndex + pageSize;

  return {
    items: items.slice(startIndex, endIndex),
    page,
    totalPages,
  };
}

function telegramThreadKey(chatId: number | undefined): string {
  if (chatId === undefined) {
    throw new Error('telegram message has no chat id');
  }

  return `telegram:chat:${chatId}`;
}

function isMessageNotModifiedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes('message is not modified');
}
