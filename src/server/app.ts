import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  OAuthLoginAttemptSnapshot,
  OAuthLoginInputKind,
  ProviderAuthStatus,
  ProviderCatalogEntry,
} from '../runtime/pi-auth.js';
import {
  OAuthLoginAttemptNotFoundError,
  OAuthLoginCapacityExceededError,
  OAuthLoginInvalidStateError,
  OAuthLoginProviderNotFoundError,
} from '../runtime/pi-auth.js';
import type { ThreadControlService, ThreadRuntimeState } from '../runtime/pi-executor.js';
import {
  type ApiErrorResponse,
  authLoginAttemptParamsSchema,
  authProviderParamsSchema,
  oauthOwnerHeaderName,
  postMessageRequestSchema,
  type RunResponse,
  resetThreadSessionResponseSchema,
  runParamsSchema,
  setThreadModelRequestSchema,
  setThreadThinkingRequestSchema,
  shareThreadSessionResponseSchema,
  submitOAuthLoginInputRequestSchema,
  threadParamsSchema,
} from '../shared/api-contracts.js';
import type { RunRecord } from '../shared/run-types.js';
import type { RunService } from './service.js';

const idempotencyHeaderSchema = z.string().trim().min(1).optional();
const oauthOwnerKeySchema = z.string().trim().min(1);

interface AppOptions {
  runService: RunService;
  authService?: {
    getProviderStatuses(): ProviderAuthStatus[];
    getProviderCatalog(): ProviderCatalogEntry[];
    startOAuthLogin?(provider: string, ownerKey: string): OAuthLoginAttemptSnapshot;
    getOAuthLoginAttempt?(attemptId: string, ownerKey: string): OAuthLoginAttemptSnapshot | null;
    submitOAuthLoginInput?(
      attemptId: string,
      ownerKey: string,
      value: string,
      expectedKind?: OAuthLoginInputKind,
    ): OAuthLoginAttemptSnapshot;
    cancelOAuthLogin?(attemptId: string, ownerKey: string): OAuthLoginAttemptSnapshot;
  };
  threadControlService?: ThreadControlService;
  logger?: FastifyBaseLogger;
}

export function createApp(options: AppOptions): FastifyInstance {
  let app: FastifyInstance;

  if (options.logger) {
    app = Fastify({
      loggerInstance: options.logger,
      disableRequestLogging: true,
    });
  } else {
    app = Fastify({ logger: false });
  }

  const requestStartedAt = new WeakMap<object, bigint>();

  app.addHook('onRequest', async (request) => {
    requestStartedAt.set(request, process.hrtime.bigint());
  });

  app.addHook('onError', async (request, reply, error) => {
    request.log.error({
      event: 'http_request_failed',
      request_id: request.id,
      method: request.method,
      route: request.routeOptions.url,
      url: request.url,
      status_code: reply.statusCode,
      err: error,
    });
  });

  app.addHook('onResponse', async (request, reply) => {
    const startedAt = requestStartedAt.get(request);
    requestStartedAt.delete(request);

    const durationMs = startedAt === undefined ? null : Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    request.log.info({
      event: 'http_request_completed',
      request_id: request.id,
      method: request.method,
      route: request.routeOptions.url,
      url: request.url,
      status_code: reply.statusCode,
      duration_ms: durationMs,
    });
  });

  app.get('/healthz', async () => {
    return { ok: true };
  });

  app.post('/v1/messages', async (request, reply) => {
    const bodyResult = postMessageRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send(errorResponse('invalid_message_payload', bodyResult.error.issues[0]?.message));
    }

    const headerResult = idempotencyHeaderSchema.safeParse(request.headers['idempotency-key']);
    if (!headerResult.success) {
      return reply
        .status(400)
        .send(errorResponse('invalid_idempotency_key_header', headerResult.error.issues[0]?.message));
    }

    const body = bodyResult.data;
    if (body.idempotency_key && headerResult.data && body.idempotency_key !== headerResult.data) {
      return reply
        .status(400)
        .send(
          errorResponse(
            'idempotency_key_mismatch',
            'idempotency key in request body does not match Idempotency-Key header',
          ),
        );
    }

    const result = await options.runService.ingestMessage({
      source: body.source,
      threadKey: body.thread_key,
      userKey: body.user_key,
      text: body.text,
      deliveryMode: body.delivery_mode,
      idempotencyKey: body.idempotency_key ?? headerResult.data,
    });

    return reply.status(202).send(runResponse(result.run));
  });

  app.get('/v1/runs/:run_id', async (request, reply) => {
    const paramsResult = runParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send(errorResponse('invalid_run_id', paramsResult.error.issues[0]?.message));
    }

    const run = await options.runService.getRun(paramsResult.data.run_id);
    if (!run) {
      return reply.status(404).send(errorResponse('run_not_found', `run ${paramsResult.data.run_id} not found`));
    }

    return reply.send(runResponse(run));
  });

  app.get('/v1/auth/providers', async (_request, reply) => {
    if (!options.authService) {
      return reply.status(501).send(errorResponse('auth_unavailable', 'auth service is not configured'));
    }

    return reply.send({
      providers: options.authService.getProviderStatuses(),
    });
  });

  app.get('/v1/models', async (_request, reply) => {
    if (!options.authService) {
      return reply.status(501).send(errorResponse('auth_unavailable', 'auth service is not configured'));
    }

    return reply.send({
      providers: options.authService.getProviderCatalog(),
    });
  });

  app.post('/v1/auth/providers/:provider/login', async (request, reply) => {
    const authService = options.authService;
    if (!authService?.startOAuthLogin) {
      return reply.status(501).send(errorResponse('auth_login_unavailable', 'OAuth login is not configured'));
    }

    const paramsResult = authProviderParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send(errorResponse('invalid_provider', paramsResult.error.issues[0]?.message));
    }

    const ownerHeaderResult = parseOptionalOAuthOwnerKey(request.headers[oauthOwnerHeaderName]);
    if (!ownerHeaderResult.success) {
      return reply.status(400).send(errorResponse('invalid_auth_owner_key', ownerHeaderResult.message));
    }

    const ownerKey = ownerHeaderResult.ownerKey ?? randomUUID();

    try {
      const attempt = authService.startOAuthLogin(paramsResult.data.provider, ownerKey);
      return reply.send(oauthLoginAttemptResponse(attempt));
    } catch (error) {
      return handleOAuthLoginError(reply, error);
    }
  });

  app.get('/v1/auth/logins/:attempt_id', async (request, reply) => {
    const authService = options.authService;
    if (!authService?.getOAuthLoginAttempt) {
      return reply.status(501).send(errorResponse('auth_login_unavailable', 'OAuth login is not configured'));
    }

    const paramsResult = authLoginAttemptParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send(errorResponse('invalid_login_attempt_id', paramsResult.error.issues[0]?.message));
    }

    const ownerKeyResult = parseRequiredOAuthOwnerKey(request.headers[oauthOwnerHeaderName]);
    if (!ownerKeyResult.success) {
      return reply.status(400).send(errorResponse('invalid_auth_owner_key', ownerKeyResult.message));
    }

    const attempt = authService.getOAuthLoginAttempt(paramsResult.data.attempt_id, ownerKeyResult.ownerKey);
    if (!attempt) {
      return reply.status(404).send(errorResponse('auth_login_not_found', 'OAuth login attempt not found'));
    }

    return reply.send(oauthLoginAttemptResponse(attempt));
  });

  app.post('/v1/auth/logins/:attempt_id/input', async (request, reply) => {
    const authService = options.authService;
    if (!authService?.submitOAuthLoginInput) {
      return reply.status(501).send(errorResponse('auth_login_unavailable', 'OAuth login is not configured'));
    }

    const paramsResult = authLoginAttemptParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send(errorResponse('invalid_login_attempt_id', paramsResult.error.issues[0]?.message));
    }

    const bodyResult = submitOAuthLoginInputRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send(errorResponse('invalid_login_input_payload', bodyResult.error.issues[0]?.message));
    }

    const ownerKeyResult = parseRequiredOAuthOwnerKey(request.headers[oauthOwnerHeaderName]);
    if (!ownerKeyResult.success) {
      return reply.status(400).send(errorResponse('invalid_auth_owner_key', ownerKeyResult.message));
    }

    try {
      const attempt = authService.submitOAuthLoginInput(
        paramsResult.data.attempt_id,
        ownerKeyResult.ownerKey,
        bodyResult.data.value,
        bodyResult.data.kind,
      );
      return reply.send(oauthLoginAttemptResponse(attempt));
    } catch (error) {
      return handleOAuthLoginError(reply, error);
    }
  });

  app.post('/v1/auth/logins/:attempt_id/cancel', async (request, reply) => {
    const authService = options.authService;
    if (!authService?.cancelOAuthLogin) {
      return reply.status(501).send(errorResponse('auth_login_unavailable', 'OAuth login is not configured'));
    }

    const paramsResult = authLoginAttemptParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send(errorResponse('invalid_login_attempt_id', paramsResult.error.issues[0]?.message));
    }

    const ownerKeyResult = parseRequiredOAuthOwnerKey(request.headers[oauthOwnerHeaderName]);
    if (!ownerKeyResult.success) {
      return reply.status(400).send(errorResponse('invalid_auth_owner_key', ownerKeyResult.message));
    }

    try {
      const attempt = authService.cancelOAuthLogin(paramsResult.data.attempt_id, ownerKeyResult.ownerKey);
      return reply.send(oauthLoginAttemptResponse(attempt));
    } catch (error) {
      return handleOAuthLoginError(reply, error);
    }
  });

  app.get('/v1/threads/:thread_key/runtime', async (request, reply) => {
    if (!options.threadControlService) {
      return reply
        .status(501)
        .send(errorResponse('thread_control_unavailable', 'thread control service is not configured'));
    }

    const paramsResult = threadParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send(errorResponse('invalid_thread_key', paramsResult.error.issues[0]?.message));
    }

    try {
      const state = await options.threadControlService.getThreadRuntimeState(paramsResult.data.thread_key);
      return reply.send(threadRuntimeStateResponse(state));
    } catch (error) {
      return reply.status(400).send(errorResponse('thread_runtime_error', toErrorMessage(error)));
    }
  });

  app.put('/v1/threads/:thread_key/model', async (request, reply) => {
    if (!options.threadControlService) {
      return reply
        .status(501)
        .send(errorResponse('thread_control_unavailable', 'thread control service is not configured'));
    }

    const paramsResult = threadParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send(errorResponse('invalid_thread_key', paramsResult.error.issues[0]?.message));
    }

    const bodyResult = setThreadModelRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send(errorResponse('invalid_model_payload', bodyResult.error.issues[0]?.message));
    }

    try {
      const state = await options.threadControlService.setThreadModel(
        paramsResult.data.thread_key,
        bodyResult.data.provider,
        bodyResult.data.model_id,
      );
      return reply.send(threadRuntimeStateResponse(state));
    } catch (error) {
      return reply.status(400).send(errorResponse('thread_model_error', toErrorMessage(error)));
    }
  });

  app.put('/v1/threads/:thread_key/thinking', async (request, reply) => {
    if (!options.threadControlService) {
      return reply
        .status(501)
        .send(errorResponse('thread_control_unavailable', 'thread control service is not configured'));
    }

    const paramsResult = threadParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send(errorResponse('invalid_thread_key', paramsResult.error.issues[0]?.message));
    }

    const bodyResult = setThreadThinkingRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send(errorResponse('invalid_thinking_payload', bodyResult.error.issues[0]?.message));
    }

    try {
      const state = await options.threadControlService.setThreadThinkingLevel(
        paramsResult.data.thread_key,
        bodyResult.data.thinking_level,
      );
      return reply.send(threadRuntimeStateResponse(state));
    } catch (error) {
      return reply.status(400).send(errorResponse('thread_thinking_error', toErrorMessage(error)));
    }
  });

  app.delete('/v1/threads/:thread_key/session', async (request, reply) => {
    if (!options.threadControlService) {
      return reply
        .status(501)
        .send(errorResponse('thread_control_unavailable', 'thread control service is not configured'));
    }

    const paramsResult = threadParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send(errorResponse('invalid_thread_key', paramsResult.error.issues[0]?.message));
    }

    try {
      await options.threadControlService.resetThreadSession(paramsResult.data.thread_key);
      return reply.send(
        resetThreadSessionResponseSchema.parse({
          thread_key: paramsResult.data.thread_key,
          reset: true,
        }),
      );
    } catch (error) {
      return reply.status(400).send(errorResponse('thread_session_reset_error', toErrorMessage(error)));
    }
  });

  app.post('/v1/threads/:thread_key/share', async (request, reply) => {
    if (!options.threadControlService) {
      return reply
        .status(501)
        .send(errorResponse('thread_control_unavailable', 'thread control service is not configured'));
    }

    const paramsResult = threadParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send(errorResponse('invalid_thread_key', paramsResult.error.issues[0]?.message));
    }

    try {
      const shared = await options.threadControlService.shareThreadSession(paramsResult.data.thread_key);
      return reply.send(
        shareThreadSessionResponseSchema.parse({
          thread_key: shared.threadKey,
          gist_url: shared.gistUrl,
          share_url: shared.shareUrl,
        }),
      );
    } catch (error) {
      return reply.status(400).send(errorResponse('thread_session_share_error', toErrorMessage(error)));
    }
  });

  return app;
}

function runResponse(run: RunRecord): RunResponse {
  return {
    run_id: run.runId,
    status: run.status,
    output: run.output,
    error: run.errorMessage ? { message: run.errorMessage } : null,
  };
}

function threadRuntimeStateResponse(state: ThreadRuntimeState) {
  return {
    thread_key: state.threadKey,
    model: state.model
      ? {
          provider: state.model.provider,
          model_id: state.model.modelId,
          name: state.model.name,
        }
      : null,
    thinking_level: state.thinkingLevel,
    supports_thinking: state.supportsThinking,
    available_thinking_levels: state.availableThinkingLevels,
  };
}

function oauthLoginAttemptResponse(attempt: OAuthLoginAttemptSnapshot) {
  return {
    attempt_id: attempt.attempt_id,
    owner_key: attempt.owner_key,
    provider: attempt.provider,
    provider_name: attempt.provider_name,
    status: attempt.status,
    auth: attempt.auth,
    prompt: attempt.prompt,
    progress_messages: attempt.progress_messages,
    error: attempt.error,
  };
}

function parseOptionalOAuthOwnerKey(rawHeader: unknown):
  | {
      success: true;
      ownerKey: string | null;
    }
  | {
      success: false;
      message: string;
    } {
  if (rawHeader === undefined) {
    return {
      success: true,
      ownerKey: null,
    };
  }

  const ownerKey = normalizeSingleHeaderValue(rawHeader);
  if (ownerKey === null) {
    return {
      success: false,
      message: `${oauthOwnerHeaderName} header must be a single string value`,
    };
  }

  const parsedOwnerKey = oauthOwnerKeySchema.safeParse(ownerKey);
  if (!parsedOwnerKey.success) {
    return {
      success: false,
      message: parsedOwnerKey.error.issues[0]?.message ?? `${oauthOwnerHeaderName} header is invalid`,
    };
  }

  return {
    success: true,
    ownerKey: parsedOwnerKey.data,
  };
}

function parseRequiredOAuthOwnerKey(rawHeader: unknown):
  | {
      success: true;
      ownerKey: string;
    }
  | {
      success: false;
      message: string;
    } {
  const parsed = parseOptionalOAuthOwnerKey(rawHeader);
  if (!parsed.success) {
    return parsed;
  }

  if (!parsed.ownerKey) {
    return {
      success: false,
      message: `missing ${oauthOwnerHeaderName} header`,
    };
  }

  return {
    success: true,
    ownerKey: parsed.ownerKey,
  };
}

function normalizeSingleHeaderValue(rawHeader: unknown): string | null {
  if (typeof rawHeader === 'string') {
    return rawHeader;
  }

  if (!Array.isArray(rawHeader) || rawHeader.length !== 1 || typeof rawHeader[0] !== 'string') {
    return null;
  }

  return rawHeader[0];
}

function handleOAuthLoginError(
  reply: { status(code: number): { send(payload: ApiErrorResponse): unknown } },
  error: unknown,
) {
  if (error instanceof OAuthLoginProviderNotFoundError) {
    return reply.status(400).send(errorResponse('auth_login_provider_not_found', error.message));
  }

  if (error instanceof OAuthLoginAttemptNotFoundError) {
    return reply.status(404).send(errorResponse('auth_login_not_found', error.message));
  }

  if (error instanceof OAuthLoginInvalidStateError) {
    return reply.status(409).send(errorResponse('auth_login_invalid_state', error.message));
  }

  if (error instanceof OAuthLoginCapacityExceededError) {
    return reply.status(429).send(errorResponse('auth_login_capacity_exceeded', error.message));
  }

  return reply.status(500).send(errorResponse('auth_login_internal_error', toErrorMessage(error)));
}

function errorResponse(code: string, message?: string): ApiErrorResponse {
  return {
    error: {
      code,
      message: message ?? 'request failed',
    },
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
