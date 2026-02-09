import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { RunProgressEvent } from '../shared/run-progress.js';
import type { RunOutput, RunRecord } from '../shared/run-types.js';

export type SessionEvent = AgentSessionEvent;
type SessionMessage = Extract<SessionEvent, { type: 'message_start' | 'message_end' }>['message'];
type UserSessionMessage = Extract<SessionMessage, { role: 'user' }>;
type AssistantSessionMessage = Extract<SessionMessage, { role: 'assistant' }>;
type SessionTextContent = UserSessionMessage['content'] | AssistantSessionMessage['content'];

export type TurnSession = Pick<AgentSession, 'prompt' | 'followUp' | 'steer' | 'subscribe'>;

interface PendingRun {
  run: RunRecord;
  delivered: boolean;
  completed: boolean;
  deliveredText: string | null;
  lastAssistant: AssistantSnapshot | null;
  resolve(output: RunOutput): void;
  reject(error: Error): void;
  promise: Promise<RunOutput>;
}

interface AssistantSnapshot {
  text: string;
  provider: string | null;
  model: string | null;
  stopReason: AssistantSessionMessage['stopReason'] | null;
  errorMessage: string | null;
}

interface ThreadRunControllerOptions {
  onProgress?: (event: RunProgressEvent) => void;
}

type PendingLifecycleProgressEvent =
  | {
      type: 'agent_start';
    }
  | {
      type: 'turn_start';
    };

export class ThreadRunController {
  private readonly pendingRuns: PendingRun[] = [];
  private pendingLifecycleEvents: PendingLifecycleProgressEvent[] = [];
  private activeRun: PendingRun | null = null;
  private inFlight = false;
  private dispatchTail: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;
  private readonly onProgress?: (event: RunProgressEvent) => void;

  constructor(
    private readonly session: TurnSession,
    options: ThreadRunControllerOptions = {},
  ) {
    this.onProgress = options.onProgress;
    this.unsubscribe = session.subscribe((event) => {
      this.onSessionEvent(event);
    });
  }

  async submit(run: RunRecord): Promise<RunOutput> {
    const pending = createPendingRun(run);
    this.pendingRuns.push(pending);

    await this.dispatch(run, pending);

    return pending.promise;
  }

  dispose(): void {
    this.unsubscribe();

    for (const pending of [...this.pendingRuns]) {
      this.failRun(pending, new Error(`run ${pending.run.runId} cancelled: controller disposed`));
    }
  }

  private async dispatch(run: RunRecord, pending: PendingRun): Promise<void> {
    const dispatchPromise = this.dispatchTail.then(async () => {
      if (pending.completed) {
        return;
      }

      try {
        if (!this.inFlight) {
          this.inFlight = true;

          const promptPromise = this.session.prompt(run.inputText);
          void promptPromise.catch((error) => {
            this.failRun(pending, toError(error, `run ${run.runId} prompt failed`));
          });
          return;
        }

        if (run.deliveryMode === 'steer') {
          await this.session.steer(run.inputText);
        } else {
          await this.session.followUp(run.inputText);
        }
      } catch (error) {
        this.failRun(pending, toError(error, `run ${run.runId} enqueue failed`));
      }
    });

    this.dispatchTail = dispatchPromise.catch(() => {});
    await dispatchPromise;
  }

  private onSessionEvent(event: SessionEvent): void {
    if (event.type === 'message_start') {
      if (event.message.role === 'user') {
        this.onUserMessageStart(event.message);
      } else {
        this.flushPendingLifecycleEventsToActiveRun();
      }
      return;
    }

    if (event.type === 'message_update') {
      this.onMessageUpdateEvent(event);
      return;
    }

    if (event.type === 'message_end') {
      if (event.message.role === 'assistant' && this.activeRun) {
        this.flushPendingLifecycleEventsToActiveRun();
        this.activeRun.lastAssistant = assistantSnapshot(event.message);
      }
      return;
    }

    if (event.type === 'tool_execution_start') {
      this.emitForActiveRun({
        type: 'tool_execution_start',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
      return;
    }

    if (event.type === 'tool_execution_update') {
      this.emitForActiveRun({
        type: 'tool_execution_update',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
      });
      return;
    }

    if (event.type === 'tool_execution_end') {
      this.emitForActiveRun({
        type: 'tool_execution_end',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      });
      return;
    }

    if (event.type === 'agent_start') {
      this.queueLifecycleEvent({ type: 'agent_start' });
      return;
    }

    if (event.type === 'turn_start') {
      this.queueLifecycleEvent({ type: 'turn_start' });
      return;
    }

    if (event.type === 'turn_end') {
      this.emitForActiveRun({
        type: 'turn_end',
        toolResultCount: event.toolResults.length,
      });
      return;
    }

    if (event.type === 'agent_end') {
      this.inFlight = false;
      this.emitForActiveRun({ type: 'agent_end' });
      this.completeActiveRun('agent_end');

      if (this.pendingRuns.some((run) => !run.completed)) {
        for (const pending of [...this.pendingRuns]) {
          if (!pending.completed) {
            this.failRun(pending, new Error(`run ${pending.run.runId} failed: agent ended before message delivery`));
          }
        }
      }

      this.pendingLifecycleEvents = [];
    }
  }

  private onMessageUpdateEvent(event: Extract<SessionEvent, { type: 'message_update' }>): void {
    this.flushPendingLifecycleEventsToActiveRun();
    const assistantMessageEvent = event.assistantMessageEvent;

    if (assistantMessageEvent.type === 'text_delta') {
      this.emitForActiveRun({
        type: 'assistant_text_delta',
        delta: assistantMessageEvent.delta,
      });
      return;
    }

    if (assistantMessageEvent.type === 'thinking_delta') {
      this.emitForActiveRun({
        type: 'assistant_thinking_delta',
        delta: assistantMessageEvent.delta,
      });
    }
  }

  private onUserMessageStart(message: UserSessionMessage): void {
    const next = this.pendingRuns.find((pending) => !pending.completed && !pending.delivered);

    if (!next) {
      return;
    }

    if (this.activeRun && this.activeRun !== next) {
      this.completeActiveRun('next_user_message');
    }

    next.delivered = true;
    next.deliveredText = userMessageText(message);
    this.activeRun = next;
    this.flushPendingLifecycleEventsForRun(next.run);
    this.emitForRun(next.run, { type: 'delivered' });
  }

  private completeActiveRun(trigger: 'next_user_message' | 'agent_end'): void {
    const pending = this.activeRun;
    this.activeRun = null;

    if (!pending || pending.completed) {
      return;
    }

    if (!pending.lastAssistant) {
      this.failRun(
        pending,
        new Error(`run ${pending.run.runId} failed: no assistant response before ${trigger.replaceAll('_', ' ')}`),
      );
      return;
    }

    if (pending.lastAssistant.stopReason === 'error' || pending.lastAssistant.stopReason === 'aborted') {
      const reason = pending.lastAssistant.errorMessage ?? `assistant stopped with ${pending.lastAssistant.stopReason}`;
      this.failRun(pending, new Error(`run ${pending.run.runId} failed: ${reason}`));
      return;
    }

    this.resolveRun(pending, {
      type: 'message',
      text: pending.lastAssistant.text,
      provider: pending.lastAssistant.provider,
      model: pending.lastAssistant.model,
      delivery_mode: pending.run.deliveryMode,
    });
  }

  private resolveRun(pending: PendingRun, output: RunOutput): void {
    if (pending.completed) {
      return;
    }

    pending.completed = true;
    removePendingRun(this.pendingRuns, pending);
    pending.resolve(output);
  }

  private failRun(pending: PendingRun, error: Error): void {
    if (pending.completed) {
      return;
    }

    pending.completed = true;
    if (this.activeRun === pending) {
      this.activeRun = null;
    }

    removePendingRun(this.pendingRuns, pending);
    pending.reject(error);
  }

  private queueLifecycleEvent(event: PendingLifecycleProgressEvent): void {
    if (!this.onProgress) {
      return;
    }

    this.pendingLifecycleEvents.push(event);
  }

  private flushPendingLifecycleEventsToActiveRun(): void {
    const activeRun = this.activeRun;
    if (!activeRun || activeRun.completed) {
      return;
    }

    this.flushPendingLifecycleEventsForRun(activeRun.run);
  }

  private flushPendingLifecycleEventsForRun(run: RunRecord): void {
    if (!this.onProgress || this.pendingLifecycleEvents.length === 0) {
      return;
    }

    const queuedEvents = this.pendingLifecycleEvents;
    this.pendingLifecycleEvents = [];

    for (const event of queuedEvents) {
      this.emitForRun(run, event);
    }
  }

  private emitForActiveRun(
    event:
      | {
          type: 'agent_end';
        }
      | {
          type: 'turn_end';
          toolResultCount: number;
        }
      | {
          type: 'assistant_text_delta';
          delta: string;
        }
      | {
          type: 'assistant_thinking_delta';
          delta: string;
        }
      | {
          type: 'tool_execution_start';
          toolCallId: string;
          toolName: string;
          args: unknown;
        }
      | {
          type: 'tool_execution_update';
          toolCallId: string;
          toolName: string;
          partialResult: unknown;
        }
      | {
          type: 'tool_execution_end';
          toolCallId: string;
          toolName: string;
          result: unknown;
          isError: boolean;
        },
  ): void {
    this.flushPendingLifecycleEventsToActiveRun();

    const activeRun = this.activeRun;
    if (!activeRun || activeRun.completed) {
      return;
    }

    this.emitForRun(activeRun.run, event);
  }

  private emitForRun(
    run: RunRecord,
    event:
      | {
          type: 'delivered';
        }
      | {
          type: 'agent_start';
        }
      | {
          type: 'agent_end';
        }
      | {
          type: 'turn_start';
        }
      | {
          type: 'turn_end';
          toolResultCount: number;
        }
      | {
          type: 'assistant_text_delta';
          delta: string;
        }
      | {
          type: 'assistant_thinking_delta';
          delta: string;
        }
      | {
          type: 'tool_execution_start';
          toolCallId: string;
          toolName: string;
          args: unknown;
        }
      | {
          type: 'tool_execution_update';
          toolCallId: string;
          toolName: string;
          partialResult: unknown;
        }
      | {
          type: 'tool_execution_end';
          toolCallId: string;
          toolName: string;
          result: unknown;
          isError: boolean;
        },
  ): void {
    if (!this.onProgress) {
      return;
    }

    this.onProgress({
      ...event,
      runId: run.runId,
      threadKey: run.threadKey,
      source: run.source,
      deliveryMode: run.deliveryMode,
      timestamp: new Date().toISOString(),
    });
  }
}

function createPendingRun(run: RunRecord): PendingRun {
  const deferred = createDeferred<RunOutput>();

  return {
    run,
    delivered: false,
    completed: false,
    deliveredText: null,
    lastAssistant: null,
    resolve: deferred.resolve,
    reject: deferred.reject,
    promise: deferred.promise,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};

  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

function removePendingRun(pendingRuns: PendingRun[], pending: PendingRun): void {
  const index = pendingRuns.indexOf(pending);
  if (index >= 0) {
    pendingRuns.splice(index, 1);
  }
}

function userMessageText(message: UserSessionMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  return textContentToString(message.content);
}

function assistantSnapshot(message: AssistantSessionMessage): AssistantSnapshot {
  return {
    text: textContentToString(message.content),
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage ?? null,
  };
}

function textContentToString(content: SessionTextContent): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .flatMap((part) => {
      if (part.type !== 'text') {
        return [];
      }

      return [part.text];
    })
    .join('\n');
}

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(`${fallback}: ${String(error)}`);
}
