import { z } from 'zod';
import { deliveryModes } from './run-types.js';

export const deliveryModeSchema = z.enum(deliveryModes);
export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const thinkingLevelSchema = z.enum(thinkingLevels);

export const postMessageRequestSchema = z.object({
  source: z.string().trim().min(1).default('cli'),
  thread_key: z.string().trim().min(1).default('cli:default'),
  user_key: z.string().trim().min(1).optional(),
  text: z.string().min(1),
  delivery_mode: deliveryModeSchema.default('followUp'),
  idempotency_key: z.string().trim().min(1).optional(),
});

export const runParamsSchema = z.object({
  run_id: z.string().trim().min(1),
});

export const threadParamsSchema = z.object({
  thread_key: z.string().trim().min(1),
});

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

export type PostMessageRequest = z.infer<typeof postMessageRequestSchema>;
export type RunResponse = z.infer<typeof runResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type AuthProvidersResponse = z.infer<typeof authProvidersResponseSchema>;
export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>;
export type ThreadRuntimeStateResponse = z.infer<typeof threadRuntimeStateSchema>;
export type SetThreadModelRequest = z.infer<typeof setThreadModelRequestSchema>;
export type SetThreadThinkingRequest = z.infer<typeof setThreadThinkingRequestSchema>;
