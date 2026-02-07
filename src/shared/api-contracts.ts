import { z } from 'zod';
import { deliveryModes } from './run-types.js';

export const deliveryModeSchema = z.enum(deliveryModes);

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

export const providerAuthStatusSchema = z.object({
  provider: z.string(),
  has_auth: z.boolean(),
  credential_type: z.enum(['api_key', 'oauth']).nullable(),
  oauth_supported: z.boolean(),
  env_var_hint: z.string().nullable(),
  total_models: z.number().int().nonnegative(),
  available_models: z.number().int().nonnegative(),
});

export const authProvidersResponseSchema = z.object({
  providers: z.array(providerAuthStatusSchema),
});

export type PostMessageRequest = z.infer<typeof postMessageRequestSchema>;
export type RunResponse = z.infer<typeof runResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type AuthProvidersResponse = z.infer<typeof authProvidersResponseSchema>;
