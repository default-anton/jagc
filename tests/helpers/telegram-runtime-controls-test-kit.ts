import type { OAuthLoginAttemptSnapshot, ProviderAuthStatus, ProviderCatalogEntry } from '../../src/runtime/pi-auth.js';
import type { TelegramCloneBotCall } from './telegram-bot-api-clone.js';
import type { TelegramAdapterAuthService } from './telegram-test-kit.js';

export class FakeAuthService {
  readonly submitCalls: Array<{
    attemptId: string;
    ownerKey: string;
    value: string;
    expectedKind?: 'prompt' | 'manual_code';
  }> = [];

  failNextSubmitWithStateConflict = false;
  private readonly attempts = new Map<string, OAuthLoginAttemptSnapshot>();

  constructor(
    private readonly providerStatuses: ProviderAuthStatus[] = [
      {
        provider: 'openai-codex',
        has_auth: false,
        credential_type: null,
        oauth_supported: true,
        env_var_hint: null,
        total_models: 1,
        available_models: 0,
      },
    ],
  ) {}

  getProviderCatalog(): ProviderCatalogEntry[] {
    return [];
  }

  getProviderStatuses(): ProviderAuthStatus[] {
    return this.providerStatuses;
  }

  startOAuthLogin(provider: string, ownerKey: string): OAuthLoginAttemptSnapshot {
    const attempt: OAuthLoginAttemptSnapshot = {
      attempt_id: 'attempt-1',
      owner_key: ownerKey,
      provider,
      provider_name: 'OpenAI Codex',
      status: 'awaiting_input',
      auth: {
        url: 'https://example.com/auth',
        instructions: 'Complete login in browser.',
      },
      prompt: {
        kind: 'manual_code',
        message: 'Paste authorization code',
        placeholder: null,
        allow_empty: false,
      },
      progress_messages: ['Waiting for callback...'],
      error: null,
    };

    this.attempts.set(attempt.attempt_id, attempt);
    return attempt;
  }

  getOAuthLoginAttempt(attemptId: string, ownerKey: string): OAuthLoginAttemptSnapshot | null {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.owner_key !== ownerKey) {
      return null;
    }

    return attempt;
  }

  markAttemptSucceeded(attemptId: string): void {
    const current = this.attempts.get(attemptId);
    if (!current) {
      return;
    }

    this.attempts.set(attemptId, {
      ...current,
      status: 'succeeded',
      prompt: null,
      progress_messages: [...current.progress_messages, 'OAuth login completed'],
    });
  }

  submitOAuthLoginInput(
    attemptId: string,
    ownerKey: string,
    value: string,
    expectedKind?: 'prompt' | 'manual_code',
  ): OAuthLoginAttemptSnapshot {
    this.submitCalls.push({ attemptId, ownerKey, value, expectedKind });

    const current = this.attempts.get(attemptId);
    if (!current || current.owner_key !== ownerKey) {
      throw new Error('attempt not found');
    }

    if (this.failNextSubmitWithStateConflict) {
      this.failNextSubmitWithStateConflict = false;
      this.markAttemptSucceeded(attemptId);
      throw new Error('OAuth login attempt is not waiting for input');
    }

    const updated: OAuthLoginAttemptSnapshot = {
      ...current,
      status: 'succeeded',
      prompt: null,
      progress_messages: [...current.progress_messages, 'OAuth login completed'],
    };

    this.attempts.set(attemptId, updated);
    return updated;
  }

  cancelOAuthLogin(attemptId: string, ownerKey: string): OAuthLoginAttemptSnapshot {
    const current = this.attempts.get(attemptId);
    if (!current || current.owner_key !== ownerKey) {
      throw new Error('attempt not found');
    }

    const updated: OAuthLoginAttemptSnapshot = {
      ...current,
      status: 'cancelled',
      prompt: null,
      error: 'OAuth login cancelled',
    };

    this.attempts.set(attemptId, updated);
    return updated;
  }
}

export function createCatalogAuthService(
  providerCatalog: ProviderCatalogEntry[],
  providerStatuses: ProviderAuthStatus[] = [],
): TelegramAdapterAuthService {
  return {
    getProviderCatalog: () => providerCatalog,
    getProviderStatuses: () => providerStatuses,
    startOAuthLogin: () => notUsed('startOAuthLogin'),
    getOAuthLoginAttempt: () => null,
    submitOAuthLoginInput: () => notUsed('submitOAuthLoginInput'),
    cancelOAuthLogin: () => notUsed('cancelOAuthLogin'),
  };
}

export function createProviderCatalog(count: number): ProviderCatalogEntry[] {
  return Array.from({ length: count }, (_, index) => createProvider(`provider-${index}`, [`model-${index}`]));
}

export function createProvider(provider: string, modelIds: string[]): ProviderCatalogEntry {
  return {
    provider,
    has_auth: true,
    credential_type: 'api_key',
    oauth_supported: false,
    env_var_hint: null,
    total_models: modelIds.length,
    available_models: modelIds.length,
    models: modelIds.map((modelId) => ({
      provider,
      model_id: modelId,
      name: modelId,
      reasoning: false,
      available: true,
    })),
  };
}

export function textOf(call: TelegramCloneBotCall): string {
  const text = call.payload.text;
  if (typeof text === 'string') {
    return text;
  }

  return '';
}

export function allCallbackData(call: TelegramCloneBotCall): string[] {
  const replyMarkup = call.payload.reply_markup;
  if (!replyMarkup || typeof replyMarkup !== 'object') {
    return [];
  }

  const inlineKeyboard = (replyMarkup as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(inlineKeyboard)) {
    return [];
  }

  const callbackData: string[] = [];

  for (const row of inlineKeyboard) {
    if (!Array.isArray(row)) {
      continue;
    }

    for (const button of row) {
      if (!button || typeof button !== 'object') {
        continue;
      }

      const value = (button as { callback_data?: unknown }).callback_data;
      if (typeof value === 'string') {
        callbackData.push(value);
      }
    }
  }

  return callbackData;
}

function notUsed(name: string): never {
  throw new Error(`${name} not used in this test`);
}
