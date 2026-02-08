import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, test } from 'vitest';

import { OAuthLoginBroker, OAuthLoginCapacityExceededError } from '../src/runtime/oauth-login-broker.js';

class FakeAuthStorage {
  loginCalls = 0;

  getOAuthProviders() {
    return [
      {
        id: 'openai-codex',
        name: 'OpenAI Codex',
      },
    ];
  }

  async login(
    providerId: string,
    callbacks: {
      onAuth: (info: { url: string; instructions?: string }) => void;
      onManualCodeInput?: () => Promise<string>;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    if (providerId !== 'openai-codex') {
      throw new Error('provider not found');
    }

    this.loginCalls += 1;

    callbacks.onAuth({
      url: 'https://example.com/auth',
      instructions: 'Login in browser',
    });

    const code = await callbacks.onManualCodeInput?.();
    if (!code) {
      throw new Error('missing manual code');
    }

    if (callbacks.signal?.aborted) {
      throw new Error('cancelled');
    }
  }
}

describe('OAuthLoginBroker', () => {
  test('bridges manual code input and completes attempt', async () => {
    const broker = new OAuthLoginBroker(new FakeAuthStorage());

    const started = broker.start('openai-codex', 'owner-a');
    expect(started.provider).toBe('openai-codex');
    expect(started.owner_key).toBe('owner-a');

    const awaitingInput = await waitForStatus(broker, started.attempt_id, 'owner-a', 'awaiting_input');
    expect(awaitingInput.prompt).toMatchObject({
      kind: 'manual_code',
    });

    const afterSubmit = broker.submitInput(started.attempt_id, 'owner-a', 'code-123', 'manual_code');
    expect(afterSubmit.status).toBe('running');

    const completed = await waitForStatus(broker, started.attempt_id, 'owner-a', 'succeeded');
    expect(completed.status).toBe('succeeded');
  });

  test('reuses active attempt for same owner and provider', async () => {
    const authStorage = new FakeAuthStorage();
    const broker = new OAuthLoginBroker(authStorage);

    const first = broker.start('openai-codex', 'owner-a');
    await waitForStatus(broker, first.attempt_id, 'owner-a', 'awaiting_input');

    const second = broker.start('openai-codex', 'owner-a');

    expect(second.attempt_id).toBe(first.attempt_id);
    expect(authStorage.loginCalls).toBe(1);
  });

  test('does not share attempts across owners', async () => {
    const authStorage = new FakeAuthStorage();
    const broker = new OAuthLoginBroker(authStorage);

    const first = broker.start('openai-codex', 'owner-a');
    await waitForStatus(broker, first.attempt_id, 'owner-a', 'awaiting_input');

    const second = broker.start('openai-codex', 'owner-b');

    expect(second.attempt_id).not.toBe(first.attempt_id);
    expect(authStorage.loginCalls).toBe(2);
    expect(broker.get(first.attempt_id, 'owner-b')).toBeNull();
  });

  test('cancels an in-flight attempt', async () => {
    const broker = new OAuthLoginBroker(new FakeAuthStorage());

    const started = broker.start('openai-codex', 'owner-a');
    await waitForStatus(broker, started.attempt_id, 'owner-a', 'awaiting_input');

    const cancelled = broker.cancel(started.attempt_id, 'owner-a');
    expect(cancelled.status).toBe('cancelled');

    const finalState = await waitForStatus(broker, started.attempt_id, 'owner-a', 'cancelled');
    expect(finalState.error).toContain('cancelled');
  });

  test('rejects new attempts when all capacity is occupied by active attempts', async () => {
    const broker = new OAuthLoginBroker(new FakeAuthStorage(), {
      maxAttempts: 2,
    });

    const first = broker.start('openai-codex', 'owner-a');
    const second = broker.start('openai-codex', 'owner-b');

    await waitForStatus(broker, first.attempt_id, 'owner-a', 'awaiting_input');
    await waitForStatus(broker, second.attempt_id, 'owner-b', 'awaiting_input');

    expect(() => broker.start('openai-codex', 'owner-c')).toThrow(OAuthLoginCapacityExceededError);
    expect(broker.get(first.attempt_id, 'owner-a')?.status).toBe('awaiting_input');
  });

  test('frees capacity by pruning terminal attempts first', async () => {
    const broker = new OAuthLoginBroker(new FakeAuthStorage(), {
      maxAttempts: 2,
      terminalAttemptTtlMs: 0,
    });

    const first = broker.start('openai-codex', 'owner-a');
    const second = broker.start('openai-codex', 'owner-b');

    await waitForStatus(broker, first.attempt_id, 'owner-a', 'awaiting_input');
    await waitForStatus(broker, second.attempt_id, 'owner-b', 'awaiting_input');

    broker.cancel(first.attempt_id, 'owner-a');
    await waitForStatus(broker, first.attempt_id, 'owner-a', 'cancelled');
    await sleep(2);

    const third = broker.start('openai-codex', 'owner-c');
    expect(third.owner_key).toBe('owner-c');
    expect(broker.get(second.attempt_id, 'owner-b')?.status).toBe('awaiting_input');
  });
});

async function waitForStatus(
  broker: OAuthLoginBroker,
  attemptId: string,
  ownerKey: string,
  expectedStatus: 'awaiting_input' | 'succeeded' | 'cancelled',
) {
  const deadline = Date.now() + 1_000;

  while (Date.now() < deadline) {
    const attempt = broker.get(attemptId, ownerKey);
    if (!attempt) {
      throw new Error(`attempt ${attemptId} not found`);
    }

    if (attempt.status === expectedStatus) {
      return attempt;
    }

    await sleep(10);
  }

  throw new Error(`timed out waiting for status ${expectedStatus}`);
}
