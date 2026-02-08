import { randomUUID } from 'node:crypto';

import type { AuthStorage } from '@mariozechner/pi-coding-agent';

const defaultMaxProgressMessages = 12;
const defaultMaxAttempts = 100;
const defaultTerminalAttemptTtlMs = 30 * 60 * 1000;

export type OAuthLoginAttemptStatus = 'running' | 'awaiting_input' | 'succeeded' | 'failed' | 'cancelled';
export type OAuthLoginInputKind = 'prompt' | 'manual_code';

export interface OAuthLoginPrompt {
  kind: OAuthLoginInputKind;
  message: string;
  placeholder: string | null;
  allow_empty: boolean;
}

export interface OAuthLoginAttemptSnapshot {
  attempt_id: string;
  owner_key: string;
  provider: string;
  provider_name: string | null;
  status: OAuthLoginAttemptStatus;
  auth: {
    url: string;
    instructions: string | null;
  } | null;
  prompt: OAuthLoginPrompt | null;
  progress_messages: string[];
  error: string | null;
}

export class OAuthLoginProviderNotFoundError extends Error {
  constructor(provider: string) {
    super(`OAuth provider ${provider} is not available`);
    this.name = 'OAuthLoginProviderNotFoundError';
  }
}

export class OAuthLoginAttemptNotFoundError extends Error {
  constructor(attemptId: string) {
    super(`OAuth login attempt ${attemptId} was not found`);
    this.name = 'OAuthLoginAttemptNotFoundError';
  }
}

export class OAuthLoginInvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthLoginInvalidStateError';
  }
}

export class OAuthLoginCapacityExceededError extends Error {
  constructor(maxAttempts: number) {
    super(`OAuth login broker is at capacity (${maxAttempts} active attempts)`);
    this.name = 'OAuthLoginCapacityExceededError';
  }
}

interface OAuthLoginBrokerOptions {
  onCredentialsUpdated?: () => void;
  maxProgressMessages?: number;
  maxAttempts?: number;
  terminalAttemptTtlMs?: number;
}

interface OAuthProvider {
  id: string;
  name: string;
}

interface OAuthAuthStorage {
  getOAuthProviders(): OAuthProvider[];
  login(providerId: string, callbacks: LoginCallbacks): Promise<void>;
}

interface PendingInput {
  prompt: OAuthLoginPrompt;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

interface OAuthLoginAttemptState {
  id: string;
  ownerKey: string;
  provider: OAuthProvider;
  status: OAuthLoginAttemptStatus;
  auth: { url: string; instructions: string | null } | null;
  prompt: OAuthLoginPrompt | null;
  progressMessages: string[];
  error: string | null;
  pendingInput: PendingInput | null;
  createdAt: number;
  updatedAt: number;
  abortController: AbortController;
}

type LoginCallbacks = Parameters<AuthStorage['login']>[1];

export class OAuthLoginBroker {
  private readonly attempts = new Map<string, OAuthLoginAttemptState>();
  private readonly maxProgressMessages: number;
  private readonly maxAttempts: number;
  private readonly terminalAttemptTtlMs: number;

  constructor(
    private readonly authStorage: OAuthAuthStorage,
    private readonly options: OAuthLoginBrokerOptions = {},
  ) {
    this.maxProgressMessages = options.maxProgressMessages ?? defaultMaxProgressMessages;
    this.maxAttempts = options.maxAttempts ?? defaultMaxAttempts;
    this.terminalAttemptTtlMs = options.terminalAttemptTtlMs ?? defaultTerminalAttemptTtlMs;
  }

  start(providerId: string, ownerKey: string): OAuthLoginAttemptSnapshot {
    this.pruneAttempts();

    const provider = this.authStorage.getOAuthProviders().find((entry) => entry.id === providerId);
    if (!provider) {
      throw new OAuthLoginProviderNotFoundError(providerId);
    }

    const existingAttempt = this.findActiveAttempt(provider.id, ownerKey);
    if (existingAttempt) {
      return this.snapshot(existingAttempt);
    }

    if (this.attempts.size >= this.maxAttempts) {
      throw new OAuthLoginCapacityExceededError(this.maxAttempts);
    }

    const now = Date.now();
    const attempt: OAuthLoginAttemptState = {
      id: randomUUID(),
      ownerKey,
      provider: {
        id: provider.id,
        name: provider.name,
      },
      status: 'running',
      auth: null,
      prompt: null,
      progressMessages: [],
      error: null,
      pendingInput: null,
      createdAt: now,
      updatedAt: now,
      abortController: new AbortController(),
    };

    this.attempts.set(attempt.id, attempt);
    void this.runAttempt(attempt);

    return this.snapshot(attempt);
  }

  get(attemptId: string, ownerKey: string): OAuthLoginAttemptSnapshot | null {
    this.pruneAttempts();

    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.ownerKey !== ownerKey) {
      return null;
    }

    return this.snapshot(attempt);
  }

  submitInput(
    attemptId: string,
    ownerKey: string,
    value: string,
    expectedKind?: OAuthLoginInputKind,
  ): OAuthLoginAttemptSnapshot {
    const attempt = this.getOwnedAttemptOrThrow(attemptId, ownerKey);

    if (attempt.status !== 'awaiting_input' || !attempt.pendingInput || !attempt.prompt) {
      throw new OAuthLoginInvalidStateError('OAuth login attempt is not waiting for input');
    }

    if (expectedKind && attempt.prompt.kind !== expectedKind) {
      throw new OAuthLoginInvalidStateError(
        `OAuth login attempt expects ${attempt.prompt.kind} input, received ${expectedKind}`,
      );
    }

    if (!attempt.prompt.allow_empty && value.trim().length === 0) {
      throw new OAuthLoginInvalidStateError('Input must not be empty for this prompt');
    }

    const pendingInput = attempt.pendingInput;
    attempt.pendingInput = null;
    attempt.prompt = null;
    attempt.status = 'running';
    attempt.error = null;
    attempt.updatedAt = Date.now();

    pendingInput.resolve(value);

    return this.snapshot(attempt);
  }

  cancel(attemptId: string, ownerKey: string): OAuthLoginAttemptSnapshot {
    const attempt = this.getOwnedAttemptOrThrow(attemptId, ownerKey);

    if (isTerminalStatus(attempt.status)) {
      return this.snapshot(attempt);
    }

    attempt.status = 'cancelled';
    attempt.error = 'OAuth login cancelled';
    attempt.prompt = null;
    attempt.updatedAt = Date.now();

    const pendingInput = attempt.pendingInput;
    attempt.pendingInput = null;
    if (pendingInput) {
      pendingInput.reject(new Error('OAuth login cancelled'));
    }

    attempt.abortController.abort();
    return this.snapshot(attempt);
  }

  private async runAttempt(attempt: OAuthLoginAttemptState): Promise<void> {
    const callbacks: LoginCallbacks = {
      onAuth: (auth) => {
        attempt.auth = {
          url: auth.url,
          instructions: auth.instructions ?? null,
        };
        attempt.updatedAt = Date.now();
      },
      onPrompt: async (prompt) => {
        return this.waitForInput(attempt, {
          kind: 'prompt',
          message: prompt.message,
          placeholder: prompt.placeholder ?? null,
          allow_empty: prompt.allowEmpty ?? false,
        });
      },
      onProgress: (message) => {
        const trimmed = message.trim();
        if (!trimmed) {
          return;
        }

        if (attempt.progressMessages.at(-1) !== trimmed) {
          attempt.progressMessages.push(trimmed);
          if (attempt.progressMessages.length > this.maxProgressMessages) {
            attempt.progressMessages = attempt.progressMessages.slice(-this.maxProgressMessages);
          }
        }

        attempt.updatedAt = Date.now();
      },
      onManualCodeInput: async () => {
        return this.waitForInput(attempt, {
          kind: 'manual_code',
          message: 'Paste the authorization code or full redirect URL.',
          placeholder: null,
          allow_empty: false,
        });
      },
      signal: attempt.abortController.signal,
    };

    try {
      await this.authStorage.login(attempt.provider.id, callbacks);

      if (attempt.status !== 'cancelled') {
        attempt.status = 'succeeded';
        attempt.error = null;
      }

      this.options.onCredentialsUpdated?.();
    } catch (error) {
      if (attempt.status === 'cancelled' || attempt.abortController.signal.aborted) {
        attempt.status = 'cancelled';
        attempt.error = 'OAuth login cancelled';
      } else {
        attempt.status = 'failed';
        attempt.error = toErrorMessage(error);
      }
    } finally {
      const pendingInput = attempt.pendingInput;
      attempt.pendingInput = null;
      attempt.prompt = null;
      if (pendingInput) {
        pendingInput.reject(new Error('OAuth login attempt has already completed'));
      }
      attempt.updatedAt = Date.now();
    }
  }

  private waitForInput(attempt: OAuthLoginAttemptState, prompt: OAuthLoginPrompt): Promise<string> {
    if (isTerminalStatus(attempt.status)) {
      throw new OAuthLoginInvalidStateError('OAuth login attempt has already completed');
    }

    if (attempt.pendingInput) {
      throw new OAuthLoginInvalidStateError('OAuth login attempt is already waiting for input');
    }

    attempt.status = 'awaiting_input';
    attempt.prompt = prompt;
    attempt.updatedAt = Date.now();

    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        attempt.abortController.signal.removeEventListener('abort', onAbort);
        reject(new Error('OAuth login cancelled'));
      };

      attempt.abortController.signal.addEventListener('abort', onAbort, { once: true });

      attempt.pendingInput = {
        prompt,
        resolve: (value) => {
          attempt.abortController.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          attempt.abortController.signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
    });
  }

  private getOwnedAttemptOrThrow(attemptId: string, ownerKey: string): OAuthLoginAttemptState {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.ownerKey !== ownerKey) {
      throw new OAuthLoginAttemptNotFoundError(attemptId);
    }

    return attempt;
  }

  private snapshot(attempt: OAuthLoginAttemptState): OAuthLoginAttemptSnapshot {
    return {
      attempt_id: attempt.id,
      owner_key: attempt.ownerKey,
      provider: attempt.provider.id,
      provider_name: attempt.provider.name,
      status: attempt.status,
      auth: attempt.auth,
      prompt: attempt.prompt,
      progress_messages: [...attempt.progressMessages],
      error: attempt.error,
    };
  }

  private findActiveAttempt(providerId: string, ownerKey: string): OAuthLoginAttemptState | null {
    for (const attempt of this.attempts.values()) {
      if (attempt.provider.id !== providerId || attempt.ownerKey !== ownerKey) {
        continue;
      }

      if (!isTerminalStatus(attempt.status)) {
        return attempt;
      }
    }

    return null;
  }

  private pruneAttempts(): void {
    const now = Date.now();

    for (const [attemptId, attempt] of this.attempts.entries()) {
      if (!isTerminalStatus(attempt.status)) {
        continue;
      }

      if (now - attempt.updatedAt > this.terminalAttemptTtlMs) {
        this.attempts.delete(attemptId);
      }
    }

    if (this.attempts.size <= this.maxAttempts) {
      return;
    }

    const removableAttempts = [...this.attempts.values()]
      .filter((attempt) => isTerminalStatus(attempt.status))
      .sort((left, right) => left.createdAt - right.createdAt);

    for (const attempt of removableAttempts) {
      if (this.attempts.size <= this.maxAttempts) {
        break;
      }

      this.attempts.delete(attempt.id);
    }
  }
}

function isTerminalStatus(status: OAuthLoginAttemptStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}
