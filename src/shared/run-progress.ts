import type { DeliveryMode, RunOutput } from './run-types.js';

interface RunProgressEventBase {
  runId: string;
  threadKey: string;
  source: string;
  deliveryMode: DeliveryMode;
  timestamp: string;
}

export type RunProgressEvent =
  | (RunProgressEventBase & {
      type: 'queued';
    })
  | (RunProgressEventBase & {
      type: 'started';
    })
  | (RunProgressEventBase & {
      type: 'delivered';
    })
  | (RunProgressEventBase & {
      type: 'agent_start';
    })
  | (RunProgressEventBase & {
      type: 'agent_end';
    })
  | (RunProgressEventBase & {
      type: 'turn_start';
    })
  | (RunProgressEventBase & {
      type: 'turn_end';
      toolResultCount: number;
    })
  | (RunProgressEventBase & {
      type: 'assistant_text_delta';
      delta: string;
    })
  | (RunProgressEventBase & {
      type: 'assistant_thinking_delta';
      delta: string;
    })
  | (RunProgressEventBase & {
      type: 'tool_execution_start';
      toolCallId: string;
      toolName: string;
      args: unknown;
    })
  | (RunProgressEventBase & {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      partialResult: unknown;
    })
  | (RunProgressEventBase & {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    })
  | (RunProgressEventBase & {
      type: 'succeeded';
      output: RunOutput;
    })
  | (RunProgressEventBase & {
      type: 'failed';
      errorMessage: string;
    });

export type RunProgressListener = (event: RunProgressEvent) => void;

export function isTerminalRunProgressEvent(event: RunProgressEvent): boolean {
  return event.type === 'succeeded' || event.type === 'failed';
}
