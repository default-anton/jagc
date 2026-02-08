import { type Context, InlineKeyboard } from 'grammy';
import type { OAuthLoginAttemptSnapshot, OAuthLoginInputKind, ProviderAuthStatus } from '../runtime/pi-auth.js';
import {
  callbackAuthAttemptCancel,
  callbackAuthAttemptRefresh,
  callbackAuthLogin,
  callbackAuthProviders,
  callbackSettingsOpen,
  type TelegramCallbackAction,
} from './telegram-controls-callbacks.js';
import { addCallbackButton, paginate, replyUi, telegramCallbackDataMaxBytes } from './telegram-ui.js';

const providerPageSize = 8;

interface TelegramAuthControlsOptions {
  authService?: {
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
}

type AuthService = NonNullable<TelegramAuthControlsOptions['authService']>;
type ReadyAuthService = Required<AuthService>;

interface PendingAuthInput {
  attemptId: string;
  kind: OAuthLoginInputKind;
}

export class TelegramAuthControls {
  private readonly pendingAuthInputByChat = new Map<number, PendingAuthInput>();

  constructor(private readonly options: TelegramAuthControlsOptions) {}

  async handleAuthCommand(ctx: Context, args: string): Promise<void> {
    const authService = resolveAuthService(this.options.authService);
    if (!authService) {
      await replyUi(ctx, 'OAuth login is unavailable in this server configuration.', settingsKeyboard());
      return;
    }

    const trimmedArgs = args.trim();
    if (!trimmedArgs) {
      await this.showProviderPicker(ctx, 0);
      return;
    }

    if (trimmedArgs === 'status') {
      await this.showPendingAttempt(ctx);
      return;
    }

    if (trimmedArgs.startsWith('login ')) {
      const provider = trimmedArgs.slice('login '.length).trim();
      if (!provider) {
        await replyUi(ctx, 'Usage: /auth login <provider>', settingsKeyboard());
        return;
      }

      await this.startLogin(ctx, provider);
      return;
    }

    if (trimmedArgs === 'input' || trimmedArgs.startsWith('input ')) {
      const value = args.trimStart().slice('input'.length).trimStart();
      await this.submitPendingInput(ctx, value);
      return;
    }

    await replyUi(
      ctx,
      [
        'Usage:',
        '/auth — open OAuth provider picker',
        '/auth login <provider> — start login directly',
        '/auth input <value> — submit requested code or prompt input',
        '/auth status — show current login status',
      ].join('\n'),
      settingsKeyboard(),
    );
  }

  async handleCallbackAction(ctx: Context, action: TelegramCallbackAction): Promise<void> {
    switch (action.kind) {
      case 'auth_open': {
        await this.showProviderPicker(ctx, 0);
        return;
      }
      case 'auth_providers': {
        await this.showProviderPicker(ctx, action.page);
        return;
      }
      case 'auth_login': {
        await this.startLogin(ctx, action.provider);
        return;
      }
      case 'auth_attempt_refresh': {
        await this.showAttempt(ctx, action.attemptId);
        return;
      }
      case 'auth_attempt_cancel': {
        await this.cancelAttempt(ctx, action.attemptId);
        return;
      }
      default: {
        return;
      }
    }
  }

  private async showProviderPicker(ctx: Context, requestedPage: number, notice?: string): Promise<void> {
    const authService = resolveAuthService(this.options.authService);
    if (!authService) {
      await replyUi(ctx, 'OAuth login is unavailable in this server configuration.', settingsKeyboard());
      return;
    }

    const providers = authService.getProviderStatuses().filter((provider) => provider.oauth_supported);
    if (providers.length === 0) {
      await replyUi(
        ctx,
        ['🔐 Provider login', '', 'No OAuth providers are registered in the current pi runtime.'].join('\n'),
        settingsKeyboard(),
      );
      return;
    }

    const paged = paginate(providers, requestedPage, providerPageSize);

    const lines: string[] = [];
    if (notice) {
      lines.push(notice, '');
    }

    lines.push('🔐 Provider login', `Choose provider (${paged.page + 1}/${paged.totalPages}):`);

    const keyboard = new InlineKeyboard();
    let visibleProviders = 0;
    let hiddenProviders = 0;

    for (const provider of paged.items) {
      const authMarker = provider.has_auth ? '✅' : '🔓';
      const added = addCallbackButton(
        keyboard,
        `${authMarker} ${provider.provider}`,
        callbackAuthLogin(provider.provider),
      );
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
        'No provider options fit Telegram button limits. Use jagc auth CLI/API controls for this provider list.',
      );
      keyboard.text('⚙️ Settings', callbackSettingsOpen());
      await replyUi(ctx, lines.join('\n'), keyboard);
      return;
    }

    if (paged.totalPages > 1) {
      if (paged.page > 0) {
        keyboard.text('⬅️ Prev', callbackAuthProviders(paged.page - 1));
      }
      if (paged.page < paged.totalPages - 1) {
        keyboard.text('Next ➡️', callbackAuthProviders(paged.page + 1));
      }
      keyboard.row();
    }

    keyboard.text('⚙️ Settings', callbackSettingsOpen());

    await replyUi(ctx, lines.join('\n'), keyboard);
  }

  private async startLogin(ctx: Context, provider: string): Promise<void> {
    const authService = resolveAuthService(this.options.authService);
    if (!authService) {
      await replyUi(ctx, 'OAuth login is unavailable in this server configuration.', settingsKeyboard());
      return;
    }

    const ownerKey = ownerKeyFromContext(ctx);
    if (!ownerKey) {
      await replyUi(ctx, 'Unable to resolve chat id for provider login.', settingsKeyboard());
      return;
    }

    const attempt = authService.startOAuthLogin(provider, ownerKey);
    await this.showAttempt(ctx, attempt.attempt_id, `Starting OAuth login for ${provider}...`);
  }

  private async cancelAttempt(ctx: Context, attemptId: string): Promise<void> {
    const authService = resolveAuthService(this.options.authService);
    if (!authService) {
      await replyUi(ctx, 'OAuth login is unavailable in this server configuration.', settingsKeyboard());
      return;
    }

    const ownerKey = ownerKeyFromContext(ctx);
    if (!ownerKey) {
      await replyUi(ctx, 'Unable to resolve chat id for provider login.', settingsKeyboard());
      return;
    }

    const attempt = authService.cancelOAuthLogin(attemptId, ownerKey);
    await this.showAttempt(ctx, attempt.attempt_id, 'Login cancelled.');
  }

  private async showPendingAttempt(ctx: Context): Promise<void> {
    const chatId = chatIdFromContext(ctx);
    if (chatId === null) {
      await replyUi(ctx, 'Unable to resolve chat id for auth status.', settingsKeyboard());
      return;
    }

    const pending = this.pendingAuthInputByChat.get(chatId);
    if (!pending) {
      await this.showProviderPicker(ctx, 0, 'No pending login input for this chat.');
      return;
    }

    await this.showAttempt(ctx, pending.attemptId);
  }

  private async submitPendingInput(ctx: Context, value: string): Promise<void> {
    const authService = resolveAuthService(this.options.authService);
    if (!authService) {
      await replyUi(ctx, 'OAuth login is unavailable in this server configuration.', settingsKeyboard());
      return;
    }

    const chatId = chatIdFromContext(ctx);
    if (chatId === null) {
      await replyUi(ctx, 'Unable to resolve chat id for auth input.', settingsKeyboard());
      return;
    }

    const ownerKey = ownerKeyFromChatId(chatId);
    const pendingInput = this.pendingAuthInputByChat.get(chatId);
    if (!pendingInput) {
      await replyUi(ctx, 'No pending OAuth input. Use /auth to start a provider login.', settingsKeyboard());
      return;
    }

    const currentAttempt = authService.getOAuthLoginAttempt(pendingInput.attemptId, ownerKey);
    if (!currentAttempt) {
      this.pendingAuthInputByChat.delete(chatId);
      await this.showProviderPicker(ctx, 0, 'This login attempt expired. Start login again.');
      return;
    }

    if (currentAttempt.status !== 'awaiting_input' || !currentAttempt.prompt) {
      const notice =
        currentAttempt.status === 'succeeded'
          ? 'OAuth login already completed in browser.'
          : 'OAuth login is not waiting for input right now.';
      await this.showAttempt(ctx, currentAttempt.attempt_id, notice);
      return;
    }

    if (value.trim().length === 0 && !currentAttempt.prompt.allow_empty) {
      await this.showAttempt(
        ctx,
        currentAttempt.attempt_id,
        'No input provided. If browser already finished, use /auth status or tap Refresh.',
      );
      return;
    }

    try {
      const attempt = authService.submitOAuthLoginInput(pendingInput.attemptId, ownerKey, value, pendingInput.kind);
      await this.showAttempt(ctx, attempt.attempt_id, 'Input submitted.');
    } catch (error) {
      const refreshedAttempt = authService.getOAuthLoginAttempt(pendingInput.attemptId, ownerKey);
      if (!refreshedAttempt) {
        this.pendingAuthInputByChat.delete(chatId);
        await this.showProviderPicker(ctx, 0, 'This login attempt expired. Start login again.');
        return;
      }

      if (refreshedAttempt.status === 'succeeded') {
        await this.showAttempt(ctx, refreshedAttempt.attempt_id, 'OAuth login already completed in browser.');
        return;
      }

      if (refreshedAttempt.status !== 'awaiting_input' || !refreshedAttempt.prompt) {
        await this.showAttempt(ctx, refreshedAttempt.attempt_id, 'OAuth login state changed. Refresh and continue.');
        return;
      }

      const message = isOAuthInputStateConflict(error)
        ? 'OAuth login state changed while you were typing. Please send /auth input again.'
        : `Failed to submit input: ${toErrorMessage(error)}`;
      await this.showAttempt(ctx, refreshedAttempt.attempt_id, message);
    }
  }

  private async showAttempt(ctx: Context, attemptId: string, notice?: string): Promise<void> {
    const authService = resolveAuthService(this.options.authService);
    if (!authService) {
      await replyUi(ctx, 'OAuth login is unavailable in this server configuration.', settingsKeyboard());
      return;
    }

    const ownerKey = ownerKeyFromContext(ctx);
    if (!ownerKey) {
      await replyUi(ctx, 'Unable to resolve chat id for provider login.', settingsKeyboard());
      return;
    }

    const attempt = authService.getOAuthLoginAttempt(attemptId, ownerKey);
    if (!attempt) {
      await this.showProviderPicker(ctx, 0, 'This login attempt has expired. Start a new one.');
      return;
    }

    const chatId = chatIdFromContext(ctx);
    if (chatId !== null) {
      if (attempt.status === 'awaiting_input' && attempt.prompt) {
        this.pendingAuthInputByChat.set(chatId, {
          attemptId: attempt.attempt_id,
          kind: attempt.prompt.kind,
        });
      } else {
        this.pendingAuthInputByChat.delete(chatId);
      }
    }

    const lines: string[] = [];
    if (notice) {
      lines.push(notice, '');
    }

    lines.push('🔐 Provider login', `Provider: ${attempt.provider}`, `Status: ${statusLabel(attempt.status)}`);

    if (attempt.auth?.url) {
      lines.push('', 'Open this URL to continue:', attempt.auth.url);
    }

    if (attempt.auth?.instructions) {
      lines.push('', attempt.auth.instructions);
    }

    if (attempt.prompt) {
      lines.push('', attempt.prompt.message);
      if (attempt.prompt.allow_empty) {
        lines.push('Reply with: /auth input <value> (empty allowed)');
      } else {
        lines.push('Reply with: /auth input <value>');
      }
    }

    if (attempt.progress_messages.length > 0) {
      lines.push('', 'Progress:');
      for (const message of attempt.progress_messages.slice(-3)) {
        lines.push(`• ${message}`);
      }
    }

    if (attempt.error) {
      lines.push('', `Error: ${attempt.error}`);
    }

    const keyboard = new InlineKeyboard();
    if (attempt.auth?.url) {
      keyboard.url('🌐 Open login page', attempt.auth.url).row();
    }

    if (attempt.status === 'running' || attempt.status === 'awaiting_input') {
      let controlButtonAdded = false;
      if (addCallbackButton(keyboard, '🔄 Refresh', callbackAuthAttemptRefresh(attempt.attempt_id))) {
        controlButtonAdded = true;
      }
      if (addCallbackButton(keyboard, '🛑 Cancel', callbackAuthAttemptCancel(attempt.attempt_id))) {
        controlButtonAdded = true;
      }
      if (controlButtonAdded) {
        keyboard.row();
      } else {
        lines.push(
          '',
          `⚠️ Auth action buttons hidden due to Telegram callback limit (${telegramCallbackDataMaxBytes} bytes).`,
        );
      }
    }

    keyboard.text('⬅️ Providers', callbackAuthProviders(0)).row().text('⚙️ Settings', callbackSettingsOpen());

    await replyUi(ctx, lines.join('\n'), keyboard);
  }
}

function resolveAuthService(authService: TelegramAuthControlsOptions['authService']): ReadyAuthService | null {
  if (
    !authService?.getProviderStatuses ||
    !authService.startOAuthLogin ||
    !authService.getOAuthLoginAttempt ||
    !authService.submitOAuthLoginInput ||
    !authService.cancelOAuthLogin
  ) {
    return null;
  }

  return authService as ReadyAuthService;
}

function settingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔐 Provider login', callbackAuthProviders(0))
    .row()
    .text('⚙️ Settings', callbackSettingsOpen());
}

function statusLabel(status: OAuthLoginAttemptSnapshot['status']): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'awaiting_input':
      return 'Waiting for input';
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

function chatIdFromContext(ctx: Context): number | null {
  if (!ctx.chat?.id) {
    return null;
  }

  return ctx.chat.id;
}

function ownerKeyFromContext(ctx: Context): string | null {
  const chatId = chatIdFromContext(ctx);
  if (chatId === null) {
    return null;
  }

  return ownerKeyFromChatId(chatId);
}

function ownerKeyFromChatId(chatId: number): string {
  return `telegram:chat:${chatId}`;
}

function isOAuthInputStateConflict(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes('not waiting for input') || error.message.includes('expects');
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}
