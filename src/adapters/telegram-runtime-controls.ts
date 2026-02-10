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
  callbackSettingsOpen,
  callbackThinkingList,
  callbackThinkingSet,
  type TelegramCallbackAction,
} from './telegram-controls-callbacks.js';
import { addCallbackButton, paginate, replyUi, telegramCallbackDataMaxBytes } from './telegram-ui.js';

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

  async handleNewCommand(ctx: Context): Promise<void> {
    const threadControlService = this.options.threadControlService;
    if (!threadControlService) {
      await ctx.reply('Session reset is unavailable when JAGC_RUNNER is not pi.');
      return;
    }

    const threadKey = telegramThreadKey(ctx.chat?.id);
    await threadControlService.resetThreadSession(threadKey);
    await ctx.reply('✅ Session reset. Your next message will start a new pi session.');
  }

  async handleShareCommand(ctx: Context): Promise<void> {
    const threadControlService = this.options.threadControlService;
    if (!threadControlService) {
      await ctx.reply('Session sharing is unavailable when JAGC_RUNNER is not pi.');
      return;
    }

    const threadKey = telegramThreadKey(ctx.chat?.id);
    const shared = await threadControlService.shareThreadSession(threadKey);
    await ctx.reply(`Share URL: ${shared.shareUrl}\nGist: ${shared.gistUrl}`);
  }

  async handleStaleCallback(ctx: Context): Promise<void> {
    await this.showSettingsPanel(ctx, '⚠️ This menu is outdated. Showing latest settings.');
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
      case 'settings_open': {
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
        await this.setModelFromPicker(ctx, action.provider, action.modelId);
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

  private async showSettingsPanel(ctx: Context, notice?: string): Promise<void> {
    const threadControlService = this.options.threadControlService;
    if (!threadControlService) {
      await replyUi(
        ctx,
        'Runtime controls are unavailable when JAGC_RUNNER is not pi.',
        new InlineKeyboard().text('ℹ️ Help', callbackSettingsOpen()),
      );
      return;
    }

    const threadKey = telegramThreadKey(ctx.chat?.id);
    const state = await threadControlService.getThreadRuntimeState(threadKey);

    const lines: string[] = [];
    if (notice) {
      lines.push(notice, '');
    }

    lines.push(
      '⚙️ Runtime settings',
      `Model: ${formatModelValue(state)}`,
      `Thinking: ${state.thinkingLevel}`,
      '',
      'Choose what to change:',
    );

    await replyUi(ctx, lines.join('\n'), settingsKeyboard());
  }

  private async showModelProviderPicker(ctx: Context, requestedPage: number): Promise<void> {
    const threadControlService = this.options.threadControlService;
    const authService = this.options.authService;

    if (!threadControlService) {
      await replyUi(ctx, 'Model controls are unavailable when JAGC_RUNNER is not pi.', settingsKeyboard());
      return;
    }

    if (!authService) {
      await replyUi(ctx, 'Model catalog is unavailable.', settingsKeyboard());
      return;
    }

    const threadKey = telegramThreadKey(ctx.chat?.id);
    const state = await threadControlService.getThreadRuntimeState(threadKey);

    const providers = authService.getProviderCatalog().filter((provider) => provider.available_models > 0);
    if (providers.length === 0) {
      await replyUi(
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
    let visibleProviders = 0;
    let hiddenProviders = 0;

    for (const provider of paged.items) {
      const callbackData = callbackModelList(provider.provider, 0);
      const added = addCallbackButton(keyboard, `${provider.provider} (${provider.available_models})`, callbackData);
      if (!added) {
        hiddenProviders += 1;
        continue;
      }

      visibleProviders += 1;
      keyboard.row();
    }

    if (hiddenProviders > 0) {
      lines.push(
        '',
        `⚠️ ${hiddenProviders} provider option(s) hidden due to Telegram callback limit (${telegramCallbackDataMaxBytes} bytes).`,
      );
    }

    if (visibleProviders === 0) {
      lines.push(
        '',
        'No provider options fit Telegram button limits. Use jagc CLI/API model controls for this provider list.',
      );
      keyboard.text('⚙️ Settings', callbackSettingsOpen());
      await replyUi(ctx, lines.join('\n'), keyboard);
      return;
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

    keyboard.text('⚙️ Settings', callbackSettingsOpen());

    await replyUi(ctx, lines.join('\n'), keyboard);
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
      await replyUi(ctx, 'Model controls are unavailable when JAGC_RUNNER is not pi.', settingsKeyboard());
      return;
    }

    if (!authService) {
      await replyUi(ctx, 'Model catalog is unavailable.', settingsKeyboard());
      return;
    }

    const provider = authService.getProviderCatalog().find((entry) => entry.provider === providerName);
    if (!provider) {
      await replyUi(ctx, 'Provider not found. Use /model to reopen the model picker.', settingsKeyboard());
      return;
    }

    const threadKey = telegramThreadKey(ctx.chat?.id);
    const state = await threadControlService.getThreadRuntimeState(threadKey);

    const availableModels = provider.models.filter((model) => model.available).map((model) => ({ model }));

    if (availableModels.length === 0) {
      await replyUi(
        ctx,
        [`🤖 Model selection`, `Provider: ${provider.provider}`, '', 'No available models for this provider.'].join(
          '\n',
        ),
        new InlineKeyboard()
          .text('⬅️ Back to providers', callbackModelProviders(0))
          .row()
          .text('⚙️ Settings', callbackSettingsOpen()),
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
    let visibleModels = 0;
    let hiddenModels = 0;

    for (const { model } of paged.items) {
      const selected = state.model?.provider === provider.provider && state.model.modelId === model.model_id;
      const prefix = selected ? '✅' : '◻️';
      const reasoning = model.reasoning ? ' 🧠' : '';
      const callbackData = callbackModelSet(provider.provider, model.model_id);
      const added = addCallbackButton(keyboard, `${prefix} ${model.model_id}${reasoning}`, callbackData);
      if (!added) {
        hiddenModels += 1;
        continue;
      }

      visibleModels += 1;
      keyboard.row();
    }

    if (hiddenModels > 0) {
      lines.push(
        '',
        `⚠️ ${hiddenModels} model option(s) hidden due to Telegram callback limit (${telegramCallbackDataMaxBytes} bytes).`,
      );
    }

    if (visibleModels === 0) {
      lines.push('', 'No model options fit Telegram button limits. Use jagc CLI/API model controls for this provider.');
    }

    if (paged.totalPages > 1) {
      let hasPageButton = false;

      if (paged.page > 0) {
        const prevData = callbackModelList(provider.provider, paged.page - 1);
        if (addCallbackButton(keyboard, '⬅️ Prev', prevData)) {
          hasPageButton = true;
        }
      }
      if (paged.page < paged.totalPages - 1) {
        const nextData = callbackModelList(provider.provider, paged.page + 1);
        if (addCallbackButton(keyboard, 'Next ➡️', nextData)) {
          hasPageButton = true;
        }
      }
      if (hasPageButton) {
        keyboard.row();
      }
    }

    keyboard.text('⬅️ Providers', callbackModelProviders(0)).row().text('⚙️ Settings', callbackSettingsOpen());

    await replyUi(ctx, lines.join('\n'), keyboard);
  }

  private async setModelFromPicker(ctx: Context, providerName: string, modelId: string): Promise<void> {
    const threadControlService = this.options.threadControlService;
    const authService = this.options.authService;

    if (!threadControlService || !authService) {
      await replyUi(ctx, 'Model controls are unavailable.', settingsKeyboard());
      return;
    }

    const provider = authService.getProviderCatalog().find((entry) => entry.provider === providerName);
    if (!provider) {
      await replyUi(ctx, 'Provider not found. Use /model to reopen the model picker.', settingsKeyboard());
      return;
    }

    const selectedModel = provider.models.find((model) => model.available && model.model_id === modelId);
    if (!selectedModel) {
      await replyUi(ctx, 'Model option expired. Reopen /model and try again.', settingsKeyboard());
      return;
    }

    const threadKey = telegramThreadKey(ctx.chat?.id);
    await threadControlService.setThreadModel(threadKey, provider.provider, selectedModel.model_id);

    await this.showSettingsPanel(ctx, `✅ Model set to ${provider.provider}/${selectedModel.model_id}`);
  }

  private async showThinkingPicker(ctx: Context, notice?: string): Promise<void> {
    const threadControlService = this.options.threadControlService;
    if (!threadControlService) {
      await replyUi(ctx, 'Thinking controls are unavailable when JAGC_RUNNER is not pi.', settingsKeyboard());
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
      keyboard.text('🤖 Change model', callbackModelProviders(0)).row().text('⚙️ Settings', callbackSettingsOpen());
      await replyUi(ctx, lines.join('\n'), keyboard);
      return;
    }

    let hiddenLevels = 0;

    for (let i = 0; i < availableLevels.length; i += 2) {
      const first = availableLevels[i];
      if (!first) {
        continue;
      }

      let rowHasButton = false;
      const firstLabel = first === state.thinkingLevel ? `✅ ${first}` : first;
      if (addCallbackButton(keyboard, firstLabel, callbackThinkingSet(first))) {
        rowHasButton = true;
      } else {
        hiddenLevels += 1;
      }

      const second = availableLevels[i + 1];
      if (second) {
        const secondLabel = second === state.thinkingLevel ? `✅ ${second}` : second;
        if (addCallbackButton(keyboard, secondLabel, callbackThinkingSet(second))) {
          rowHasButton = true;
        } else {
          hiddenLevels += 1;
        }
      }

      if (rowHasButton) {
        keyboard.row();
      }
    }

    if (hiddenLevels > 0) {
      lines.push(
        '',
        `⚠️ ${hiddenLevels} thinking option(s) hidden due to Telegram callback limit (${telegramCallbackDataMaxBytes} bytes).`,
      );
    }

    keyboard.text('⚙️ Settings', callbackSettingsOpen()).row().text('🤖 Change model', callbackModelProviders(0));

    await replyUi(ctx, lines.join('\n'), keyboard);
  }

  private async setThinkingFromPicker(ctx: Context, thinkingLevel: string): Promise<void> {
    const threadControlService = this.options.threadControlService;
    if (!threadControlService) {
      await replyUi(ctx, 'Thinking controls are unavailable when JAGC_RUNNER is not pi.', settingsKeyboard());
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

    await this.showSettingsPanel(ctx, `✅ Thinking set to ${state.thinkingLevel}`);
  }
}

function settingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🤖 Change model', callbackModelProviders(0))
    .row()
    .text('🧠 Change thinking', callbackThinkingList())
    .row()
    .text('🔐 Provider login', callbackAuthProviders(0));
}

function formatModelValue(state: ThreadRuntimeState): string {
  if (!state.model) {
    return '(default)';
  }

  return `${state.model.provider}/${state.model.modelId}`;
}

function telegramThreadKey(chatId: number | undefined): string {
  if (chatId === undefined) {
    throw new Error('telegram message has no chat id');
  }

  return `telegram:chat:${chatId}`;
}
