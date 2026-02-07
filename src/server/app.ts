import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProviderAuthStatus } from '../runtime/pi-auth.js';
import {
  type ApiErrorResponse,
  postMessageRequestSchema,
  type RunResponse,
  runParamsSchema,
} from '../shared/api-contracts.js';
import type { RunRecord } from '../shared/run-types.js';
import type { RunService } from './service.js';

const idempotencyHeaderSchema = z.string().trim().min(1).optional();

interface AppOptions {
  runService: RunService;
  authService?: {
    getProviderStatuses(): ProviderAuthStatus[];
  };
  logger?: boolean | object;
}

export function createApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

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

function errorResponse(code: string, message?: string): ApiErrorResponse {
  return {
    error: {
      code,
      message: message ?? 'request failed',
    },
  };
}
