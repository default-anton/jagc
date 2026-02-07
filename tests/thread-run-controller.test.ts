import { describe, expect, test } from 'vitest';

import { type SessionEvent, ThreadRunController, type TurnSession } from '../src/runtime/thread-run-controller.js';
import type { RunRecord } from '../src/shared/run-types.js';

class FakeSession implements TurnSession {
  private listener: ((event: SessionEvent) => void) | null = null;

  readonly promptCalls: string[] = [];
  readonly followUpCalls: string[] = [];
  readonly steerCalls: string[] = [];

  async prompt(text: string): Promise<void> {
    this.promptCalls.push(text);
  }

  async followUp(text: string): Promise<void> {
    this.followUpCalls.push(text);
  }

  async steer(text: string): Promise<void> {
    this.steerCalls.push(text);
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listener = listener;

    return () => {
      this.listener = null;
    };
  }

  emit(event: SessionEvent): void {
    this.listener?.(event);
  }
}

describe('ThreadRunController', () => {
  test('maps follow-up run output to the correct assistant turn', async () => {
    const session = new FakeSession();
    const controller = new ThreadRunController(session);

    const run1Promise = controller.submit(runRecord('run-1', 'first', 'followUp'));
    const run2Promise = controller.submit(runRecord('run-2', 'second', 'followUp'));

    await flushAsync();

    expect(session.promptCalls).toEqual(['first']);
    expect(session.followUpCalls).toEqual(['second']);

    session.emit(userStart('first'));
    session.emit(assistantEnd('RUN1', 'openai', 'gpt-test'));
    session.emit(userStart('second'));

    await expect(run1Promise).resolves.toMatchObject({
      text: 'RUN1',
      provider: 'openai',
      model: 'gpt-test',
      delivery_mode: 'followUp',
    });

    session.emit(assistantEnd('RUN2', 'openai', 'gpt-test'));
    session.emit({ type: 'agent_end' });

    await expect(run2Promise).resolves.toMatchObject({
      text: 'RUN2',
      provider: 'openai',
      model: 'gpt-test',
      delivery_mode: 'followUp',
    });

    controller.dispose();
  });

  test('uses steer queue when delivery mode is steer', async () => {
    const session = new FakeSession();
    const controller = new ThreadRunController(session);

    const run1Promise = controller.submit(runRecord('run-1', 'first', 'followUp'));
    const run2Promise = controller.submit(runRecord('run-2', 'interrupt', 'steer'));

    await flushAsync();

    expect(session.promptCalls).toEqual(['first']);
    expect(session.steerCalls).toEqual(['interrupt']);

    session.emit(userStart('first'));
    session.emit(assistantEnd('RUN1', 'openai', 'gpt-test'));
    session.emit(userStart('interrupt'));

    await expect(run1Promise).resolves.toMatchObject({
      text: 'RUN1',
    });

    session.emit(assistantEnd('RUN2', 'openai', 'gpt-test'));
    session.emit({ type: 'agent_end' });

    await expect(run2Promise).resolves.toMatchObject({
      text: 'RUN2',
      delivery_mode: 'steer',
    });

    controller.dispose();
  });

  test('fails undelivered queued runs when agent ends early', async () => {
    const session = new FakeSession();
    const controller = new ThreadRunController(session);

    const run1Promise = controller.submit(runRecord('run-1', 'first', 'followUp'));
    const run2Promise = controller.submit(runRecord('run-2', 'second', 'followUp'));

    await flushAsync();

    session.emit(userStart('first'));
    session.emit(assistantEnd('RUN1', 'openai', 'gpt-test'));
    session.emit({ type: 'agent_end' });

    await expect(run1Promise).resolves.toMatchObject({ text: 'RUN1' });
    await expect(run2Promise).rejects.toThrow('agent ended before message delivery');

    controller.dispose();
  });
});

function runRecord(runId: string, inputText: string, deliveryMode: 'steer' | 'followUp'): RunRecord {
  const now = new Date().toISOString();

  return {
    runId,
    source: 'test',
    threadKey: 'thread:test',
    userKey: null,
    deliveryMode,
    status: 'running',
    inputText,
    output: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  };
}

function userStart(text: string) {
  return {
    type: 'message_start',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  };
}

function assistantEnd(text: string, provider: string, model: string) {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      provider,
      model,
      stopReason: 'stop',
    },
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
