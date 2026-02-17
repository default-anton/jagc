import { z } from 'zod';
import { deliveryModes } from './run-types.js';

export const deliveryModeSchema = z.enum(deliveryModes);
export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const thinkingLevelSchema = z.enum(thinkingLevels);

export const postMessageImageSchema = z.object({
  mime_type: z.string().trim().min(1),
  data_base64: z.string().min(1),
  filename: z.string().trim().min(1).optional(),
});

export const postMessageRequestSchema = z.object({
  source: z.string().trim().min(1).default('cli'),
  thread_key: z.string().trim().min(1).default('cli:default'),
  user_key: z.string().trim().min(1).optional(),
  text: z.string().min(1),
  delivery_mode: deliveryModeSchema.default('followUp'),
  idempotency_key: z.string().trim().min(1).optional(),
  images: z.array(postMessageImageSchema).optional(),
});

export const runParamsSchema = z.object({
  run_id: z.string().trim().min(1),
});

export const taskParamsSchema = z.object({
  task_id: z.string().trim().min(1),
});

export const threadParamsSchema = z.object({
  thread_key: z.string().trim().min(1),
});

export const authProviderParamsSchema = z.object({
  provider: z.string().trim().min(1),
});

export const authLoginAttemptParamsSchema = z.object({
  attempt_id: z.string().trim().min(1),
});

export const oauthOwnerHeaderName = 'x-jagc-auth-owner' as const;

export const runResponseSchema = z.object({
  run_id: z.string(),
  status: z.enum(['running', 'succeeded', 'failed']),
  output: z.record(z.string(), z.unknown()).nullable(),
  error: z
    .object({
      message: z.string(),
    })
    .nullable(),
});

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const providerModelSchema = z.object({
  provider: z.string(),
  model_id: z.string(),
  name: z.string(),
  reasoning: z.boolean(),
  available: z.boolean(),
});

export const providerAuthStatusSchema = z.object({
  provider: z.string(),
  has_auth: z.boolean(),
  credential_type: z.enum(['api_key', 'oauth']).nullable(),
  oauth_supported: z.boolean(),
  env_var_hint: z.string().nullable(),
  total_models: z.number().int().nonnegative(),
  available_models: z.number().int().nonnegative(),
});

export const providerCatalogSchema = providerAuthStatusSchema.extend({
  models: z.array(providerModelSchema),
});

export const authProvidersResponseSchema = z.object({
  providers: z.array(providerAuthStatusSchema),
});

export const modelCatalogResponseSchema = z.object({
  providers: z.array(providerCatalogSchema),
});

export const oauthLoginPromptKindSchema = z.enum(['prompt', 'manual_code']);

export const oauthLoginPromptSchema = z.object({
  kind: oauthLoginPromptKindSchema,
  message: z.string(),
  placeholder: z.string().nullable(),
  allow_empty: z.boolean(),
});

export const oauthLoginAttemptStatusSchema = z.enum(['running', 'awaiting_input', 'succeeded', 'failed', 'cancelled']);

export const oauthLoginAttemptSchema = z.object({
  attempt_id: z.string(),
  owner_key: z.string(),
  provider: z.string(),
  provider_name: z.string().nullable(),
  status: oauthLoginAttemptStatusSchema,
  auth: z
    .object({
      url: z.string(),
      instructions: z.string().nullable(),
    })
    .nullable(),
  prompt: oauthLoginPromptSchema.nullable(),
  progress_messages: z.array(z.string()),
  error: z.string().nullable(),
});

export const submitOAuthLoginInputRequestSchema = z.object({
  kind: oauthLoginPromptKindSchema.optional(),
  value: z.string(),
});

export const threadRuntimeStateSchema = z.object({
  thread_key: z.string(),
  model: z
    .object({
      provider: z.string(),
      model_id: z.string(),
      name: z.string().nullable(),
    })
    .nullable(),
  thinking_level: thinkingLevelSchema,
  supports_thinking: z.boolean(),
  available_thinking_levels: z.array(thinkingLevelSchema),
});

export const setThreadModelRequestSchema = z.object({
  provider: z.string().trim().min(1),
  model_id: z.string().trim().min(1),
});

export const setThreadThinkingRequestSchema = z.object({
  thinking_level: thinkingLevelSchema,
});

export const cancelThreadRunResponseSchema = z.object({
  thread_key: z.string(),
  cancelled: z.boolean(),
});

export const resetThreadSessionResponseSchema = z.object({
  thread_key: z.string(),
  reset: z.literal(true),
});

export const shareThreadSessionResponseSchema = z.object({
  thread_key: z.string(),
  gist_url: z.string().trim().min(1),
  share_url: z.string().trim().min(1),
});

const scheduleCreateOnceSchema = z.object({
  kind: z.literal('once'),
  once_at: z.string().trim().min(1),
  timezone: z.string().trim().min(1),
});

const scheduleCreateCronSchema = z.object({
  kind: z.literal('cron'),
  cron: z.string().trim().min(1),
  timezone: z.string().trim().min(1),
});

const scheduleCreateRRuleSchema = z.object({
  kind: z.literal('rrule'),
  rrule: z.string().trim().min(1),
  timezone: z.string().trim().min(1),
});

export const taskCreateScheduleSchema = z.discriminatedUnion('kind', [
  scheduleCreateOnceSchema,
  scheduleCreateCronSchema,
  scheduleCreateRRuleSchema,
]);

export const createTaskRequestSchema = z.object({
  title: z.string().trim().min(1),
  instructions: z.string().trim().min(1),
  schedule: taskCreateScheduleSchema,
});

export const updateTaskRequestSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    instructions: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
    schedule: taskCreateScheduleSchema.optional(),
  })
  .refine((payload) => Object.keys(payload).length > 0, 'at least one task field must be provided');

export const taskListQuerySchema = z.object({
  thread_key: z.string().trim().min(1).optional(),
  state: z.enum(['all', 'enabled', 'disabled']).optional(),
});

export const taskDeliveryTargetSchema = z.object({
  provider: z.string(),
  route: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const taskScheduleResponseSchema = z.object({
  kind: z.enum(['once', 'cron', 'rrule']),
  once_at: z.string().nullable(),
  cron: z.string().nullable(),
  rrule: z.string().nullable(),
  timezone: z.string(),
});

export const scheduledTaskSchema = z.object({
  task_id: z.string(),
  title: z.string(),
  instructions: z.string(),
  schedule: taskScheduleResponseSchema,
  enabled: z.boolean(),
  next_run_at: z.string().nullable(),
  creator_thread_key: z.string(),
  owner_user_key: z.string().nullable(),
  delivery_target: taskDeliveryTargetSchema,
  execution_thread_key: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  last_run_at: z.string().nullable(),
  last_run_status: z.enum(['succeeded', 'failed']).nullable(),
  last_error_message: z.string().nullable(),
});

export const taskResponseSchema = z.object({
  task: scheduledTaskSchema,
  warnings: z.array(z.string()).optional(),
});

export const taskListResponseSchema = z.object({
  tasks: z.array(scheduledTaskSchema),
});

export const deleteTaskResponseSchema = z.object({
  deleted: z.boolean(),
});

export const runNowTaskResponseSchema = z.object({
  task: scheduledTaskSchema,
  task_run: z.object({
    task_run_id: z.string(),
    task_id: z.string(),
    scheduled_for: z.string(),
    idempotency_key: z.string(),
    run_id: z.string().nullable(),
    status: z.enum(['pending', 'dispatched', 'succeeded', 'failed']),
    error_message: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
});

export type PostMessageRequest = z.infer<typeof postMessageRequestSchema>;
export type PostMessageImageInput = z.infer<typeof postMessageImageSchema>;
export type RunResponse = z.infer<typeof runResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type AuthProvidersResponse = z.infer<typeof authProvidersResponseSchema>;
export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>;
export type OAuthLoginPromptKind = z.infer<typeof oauthLoginPromptKindSchema>;
export type OAuthLoginAttemptResponse = z.infer<typeof oauthLoginAttemptSchema>;
export type SubmitOAuthLoginInputRequest = z.infer<typeof submitOAuthLoginInputRequestSchema>;
export type ThreadRuntimeStateResponse = z.infer<typeof threadRuntimeStateSchema>;
export type SetThreadModelRequest = z.infer<typeof setThreadModelRequestSchema>;
export type SetThreadThinkingRequest = z.infer<typeof setThreadThinkingRequestSchema>;
export type CancelThreadRunResponse = z.infer<typeof cancelThreadRunResponseSchema>;
export type ResetThreadSessionResponse = z.infer<typeof resetThreadSessionResponseSchema>;
export type ShareThreadSessionResponse = z.infer<typeof shareThreadSessionResponseSchema>;
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;
export type ScheduledTaskResponse = z.infer<typeof scheduledTaskSchema>;
export type TaskResponse = z.infer<typeof taskResponseSchema>;
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;
export type RunNowTaskResponse = z.infer<typeof runNowTaskResponseSchema>;
