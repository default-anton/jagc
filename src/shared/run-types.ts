export const runStatuses = ['running', 'succeeded', 'failed'] as const;

export type RunStatus = (typeof runStatuses)[number];
export type DeliveryMode = 'steer' | 'followUp';
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
}
