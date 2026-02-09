import { describe, expect, test } from 'vitest';

import { type SessionEvent, ThreadRunController, type TurnSession } from '../src/runtime/thread-run-controller.js';
import type { RunRecord } from '../src/shared/run-types.js';

type MessageStartEvent = Extract<SessionEvent, { type: 'message_start' }>;
type MessageEndEvent = Extract<SessionEvent, { type: 'message_end' }>;
type AgentStartEvent = Extract<SessionEvent, { type: 'agent_start' }>;
type TurnStartEvent = Extract<SessionEvent, { type: 'turn_start' }>;
type AgentEndEvent = Extract<SessionEvent, { type: 'agent_end' }>;
type UserMessage = Extract<MessageStartEvent['message'], { role: 'user' }>;
type AssistantMessage = Extract<MessageEndEvent['message'], { role: 'assistant' }>;

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
    session.emit(agentEnd());

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
    session.emit(agentEnd());

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
    session.emit(agentEnd());

    await expect(run1Promise).resolves.toMatchObject({ text: 'RUN1' });
    await expect(run2Promise).rejects.toThrow('agent ended before message delivery');

    controller.dispose();
  });

  test('attributes pre-delivery lifecycle events to the first delivered run', async () => {
    const session = new FakeSession();
    const events: Array<{ type: string; runId: string }> = [];

    const controller = new ThreadRunController(session, {
      onProgress: (event) => {
        events.push({ type: event.type, runId: event.runId });
      },
    });

    const runPromise = controller.submit(runRecord('run-1', 'first', 'followUp'));

    await flushAsync();

    session.emit(agentStart());
    session.emit(turnStart());
    session.emit(userStart('first'));
    session.emit(assistantEnd('RUN1', 'openai', 'gpt-test'));
    session.emit(agentEnd());

    await expect(runPromise).resolves.toMatchObject({ text: 'RUN1' });

    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'agent_start', runId: 'run-1' },
        { type: 'turn_start', runId: 'run-1' },
        { type: 'delivered', runId: 'run-1' },
      ]),
    );

    controller.dispose();
  });

  test('attributes queued turn_start events to the next delivered run', async () => {
    const session = new FakeSession();
    const events: Array<{ type: string; runId: string }> = [];

    const controller = new ThreadRunController(session, {
      onProgress: (event) => {
        events.push({ type: event.type, runId: event.runId });
      },
    });

    const run1Promise = controller.submit(runRecord('run-1', 'first', 'followUp'));
    const run2Promise = controller.submit(runRecord('run-2', 'second', 'followUp'));

    await flushAsync();

    session.emit(agentStart());
    session.emit(turnStart());
    session.emit(userStart('first'));
    session.emit(assistantEnd('RUN1', 'openai', 'gpt-test'));
    session.emit(turnStart());
    session.emit(userStart('second'));

    await expect(run1Promise).resolves.toMatchObject({ text: 'RUN1' });

    session.emit(assistantEnd('RUN2', 'openai', 'gpt-test'));
    session.emit(agentEnd());

    await expect(run2Promise).resolves.toMatchObject({ text: 'RUN2' });

    const turnStartEvents = events.filter((event) => event.type === 'turn_start');
    expect(turnStartEvents).toEqual([
      { type: 'turn_start', runId: 'run-1' },
      { type: 'turn_start', runId: 'run-2' },
    ]);

    controller.dispose();
  });

  test('emits progress events for active run tool execution and deltas', async () => {
    const session = new FakeSession();
    const events: Array<{ type: string; runId: string }> = [];

    const controller = new ThreadRunController(session, {
      onProgress: (event) => {
        events.push({ type: event.type, runId: event.runId });
      },
    });

    const runPromise = controller.submit(runRecord('run-1', 'first', 'followUp'));

    await flushAsync();

    session.emit(userStart('first'));
    const partialAssistant = assistantEnd('partial', 'openai', 'gpt-test').message as AssistantMessage;
    session.emit({
      type: 'message_update',
      message: partialAssistant,
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'hmm',
        partial: partialAssistant,
      },
    });
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'bash',
      args: { command: 'pnpm test' },
    });
    session.emit({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'bash',
      result: { ok: true },
      isError: false,
    });
    session.emit(assistantEnd('RUN1', 'openai', 'gpt-test'));
    session.emit(agentEnd());

    await expect(runPromise).resolves.toMatchObject({ text: 'RUN1' });

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['delivered', 'assistant_thinking_delta', 'tool_execution_start', 'tool_execution_end']),
    );
    expect(events.every((event) => event.runId === 'run-1')).toBe(true);

    controller.dispose();
  });
});

function runRecord(runId: string, inputText: string, deliveryMode: RunRecord['deliveryMode']): RunRecord {
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

function userStart(text: string): MessageStartEvent {
  const message: UserMessage = {
    role: 'user',
    content: text,
    timestamp: Date.now(),
  };

  return {
    type: 'message_start',
    message,
  };
}

function assistantEnd(text: string, provider: AssistantMessage['provider'], model: string): MessageEndEvent {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: {} as AssistantMessage['api'],
    provider,
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };

  return {
    type: 'message_end',
    message,
  };
}

function agentStart(): AgentStartEvent {
  return {
    type: 'agent_start',
  };
}

function turnStart(): TurnStartEvent {
  return {
    type: 'turn_start',
  };
}

function agentEnd(): AgentEndEvent {
  return {
    type: 'agent_end',
    messages: [],
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
