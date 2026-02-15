import type { FastifyInstance } from 'fastify';
import type { ThreadControlService, ThreadRuntimeState } from '../runtime/pi-executor.js';
import {
  type ApiErrorResponse,
  cancelThreadRunResponseSchema,
  resetThreadSessionResponseSchema,
  setThreadModelRequestSchema,
  setThreadThinkingRequestSchema,
  shareThreadSessionResponseSchema,
  threadParamsSchema,
  threadRuntimeStateSchema,
} from '../shared/api-contracts.js';

interface ThreadRoutesDependencies {
  threadControlService?: ThreadControlService;
  errorResponse: (code: string, message?: string) => ApiErrorResponse;
  toErrorMessage: (error: unknown) => string;
}

export function registerThreadRoutes(app: FastifyInstance, dependencies: ThreadRoutesDependencies): void {
  app.get('/v1/threads/:thread_key/runtime', async (request, reply) => {
    if (!dependencies.threadControlService) {
      return reply
        .status(501)
        .send(dependencies.errorResponse('thread_control_unavailable', 'thread control service is not configured'));
    }

    const paramsResult = threadParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_thread_key', paramsResult.error.issues[0]?.message));
    }

    try {
      const state = await dependencies.threadControlService.getThreadRuntimeState(paramsResult.data.thread_key);
      return reply.send(threadRuntimeStateResponse(state));
    } catch (error) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('thread_runtime_error', dependencies.toErrorMessage(error)));
    }
  });

  app.put('/v1/threads/:thread_key/model', async (request, reply) => {
    if (!dependencies.threadControlService) {
      return reply
        .status(501)
        .send(dependencies.errorResponse('thread_control_unavailable', 'thread control service is not configured'));
    }

    const paramsResult = threadParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_thread_key', paramsResult.error.issues[0]?.message));
    }

    const bodyResult = setThreadModelRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_model_payload', bodyResult.error.issues[0]?.message));
    }

    try {
      const state = await dependencies.threadControlService.setThreadModel(
        paramsResult.data.thread_key,
        bodyResult.data.provider,
        bodyResult.data.model_id,
      );
      return reply.send(threadRuntimeStateResponse(state));
    } catch (error) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('thread_model_error', dependencies.toErrorMessage(error)));
    }
  });

  app.put('/v1/threads/:thread_key/thinking', async (request, reply) => {
    if (!dependencies.threadControlService) {
      return reply
        .status(501)
        .send(dependencies.errorResponse('thread_control_unavailable', 'thread control service is not configured'));
    }

    const paramsResult = threadParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_thread_key', paramsResult.error.issues[0]?.message));
    }

    const bodyResult = setThreadThinkingRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_thinking_payload', bodyResult.error.issues[0]?.message));
    }

    try {
      const state = await dependencies.threadControlService.setThreadThinkingLevel(
        paramsResult.data.thread_key,
        bodyResult.data.thinking_level,
      );
      return reply.send(threadRuntimeStateResponse(state));
    } catch (error) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('thread_thinking_error', dependencies.toErrorMessage(error)));
    }
  });

  app.post('/v1/threads/:thread_key/cancel', async (request, reply) => {
    if (!dependencies.threadControlService) {
      return reply
        .status(501)
        .send(dependencies.errorResponse('thread_control_unavailable', 'thread control service is not configured'));
    }

    const paramsResult = threadParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_thread_key', paramsResult.error.issues[0]?.message));
    }

    try {
      const cancelled = await dependencies.threadControlService.cancelThreadRun(paramsResult.data.thread_key);
      return reply.send(
        cancelThreadRunResponseSchema.parse({
          thread_key: cancelled.threadKey,
          cancelled: cancelled.cancelled,
        }),
      );
    } catch (error) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('thread_run_cancel_error', dependencies.toErrorMessage(error)));
    }
  });

  app.delete('/v1/threads/:thread_key/session', async (request, reply) => {
    if (!dependencies.threadControlService) {
      return reply
        .status(501)
        .send(dependencies.errorResponse('thread_control_unavailable', 'thread control service is not configured'));
    }

    const paramsResult = threadParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_thread_key', paramsResult.error.issues[0]?.message));
    }

    try {
      await dependencies.threadControlService.resetThreadSession(paramsResult.data.thread_key);
      return reply.send(
        resetThreadSessionResponseSchema.parse({
          thread_key: paramsResult.data.thread_key,
          reset: true,
        }),
      );
    } catch (error) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('thread_session_reset_error', dependencies.toErrorMessage(error)));
    }
  });

  app.post('/v1/threads/:thread_key/share', async (request, reply) => {
    if (!dependencies.threadControlService) {
      return reply
        .status(501)
        .send(dependencies.errorResponse('thread_control_unavailable', 'thread control service is not configured'));
    }

    const paramsResult = threadParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_thread_key', paramsResult.error.issues[0]?.message));
    }

    try {
      const shared = await dependencies.threadControlService.shareThreadSession(paramsResult.data.thread_key);
      return reply.send(
        shareThreadSessionResponseSchema.parse({
          thread_key: shared.threadKey,
          gist_url: shared.gistUrl,
          share_url: shared.shareUrl,
        }),
      );
    } catch (error) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('thread_session_share_error', dependencies.toErrorMessage(error)));
    }
  });
}

function threadRuntimeStateResponse(state: ThreadRuntimeState) {
  return threadRuntimeStateSchema.parse({
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
  });
}
