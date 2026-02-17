import type { PromptOptions } from '@mariozechner/pi-coding-agent';
import type { DecodedInputImage } from './input-images.js';

export const runStatuses = ['running', 'succeeded', 'failed'] as const;
export const deliveryModes = ['steer', 'followUp'] as const satisfies readonly NonNullable<
  PromptOptions['streamingBehavior']
>[];

export type RunStatus = (typeof runStatuses)[number];
export type DeliveryMode = (typeof deliveryModes)[number];
export type RunOutput = Record<string, unknown>;

export interface RunRecord {
  runId: string;
  source: string;
  threadKey: string;
  userKey: string | null;
  deliveryMode: DeliveryMode;
  status: RunStatus;
  inputText: string;
  output: RunOutput | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageIngest {
  source: string;
  threadKey: string;
  userKey?: string;
  text: string;
  deliveryMode: DeliveryMode;
  idempotencyKey?: string;
  images?: DecodedInputImage[];
}
