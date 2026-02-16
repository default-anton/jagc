import type { FastifyInstance } from 'fastify';

import {
  type ApiErrorResponse,
  createTaskRequestSchema,
  deleteTaskResponseSchema,
  runNowTaskResponseSchema,
  taskListQuerySchema,
  taskListResponseSchema,
  taskParamsSchema,
  taskResponseSchema,
  threadParamsSchema,
  updateTaskRequestSchema,
} from '../shared/api-contracts.js';
import type { ScheduledTaskService } from './scheduled-task-service.js';
import type { ScheduledTaskRecord, ScheduledTaskRunRecord } from './scheduled-task-types.js';

interface TaskRoutesDependencies {
  scheduledTaskService?: ScheduledTaskService;
  errorResponse: (code: string, message?: string) => ApiErrorResponse;
  toErrorMessage: (error: unknown) => string;
}

export function registerTaskRoutes(app: FastifyInstance, dependencies: TaskRoutesDependencies): void {
  app.post('/v1/threads/:thread_key/tasks', async (request, reply) => {
    const scheduledTaskService = dependencies.scheduledTaskService;
    if (!scheduledTaskService) {
      return reply
        .status(501)
        .send(dependencies.errorResponse('tasks_unavailable', 'scheduled task service is not configured'));
    }

    const paramsResult = threadParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_thread_key', paramsResult.error.issues[0]?.message));
    }

    const bodyResult = createTaskRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_task_payload', bodyResult.error.issues[0]?.message));
    }

    try {
      const created = await scheduledTaskService.createTask({
        creatorThreadKey: paramsResult.data.thread_key,
        title: bodyResult.data.title,
        instructions: bodyResult.data.instructions,
        schedule:
          bodyResult.data.schedule.kind === 'once'
            ? {
                kind: 'once',
                onceAt: bodyResult.data.schedule.once_at,
                timezone: bodyResult.data.schedule.timezone,
              }
            : bodyResult.data.schedule.kind === 'cron'
              ? {
                  kind: 'cron',
                  cronExpr: bodyResult.data.schedule.cron,
                  timezone: bodyResult.data.schedule.timezone,
                }
              : {
                  kind: 'rrule',
                  rruleExpr: bodyResult.data.schedule.rrule,
                  timezone: bodyResult.data.schedule.timezone,
                },
      });

      return reply.status(201).send(taskResponseSchema.parse({ task: scheduledTaskResponse(created) }));
    } catch (error) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('task_create_error', dependencies.toErrorMessage(error)));
    }
  });

  app.get('/v1/tasks', async (request, reply) => {
    const scheduledTaskService = dependencies.scheduledTaskService;
    if (!scheduledTaskService) {
      return reply
        .status(501)
        .send(dependencies.errorResponse('tasks_unavailable', 'scheduled task service is not configured'));
    }

    const queryResult = taskListQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_task_query', queryResult.error.issues[0]?.message));
    }

    try {
      const tasks = await scheduledTaskService.listTasks({
        creatorThreadKey: queryResult.data.thread_key,
        state: queryResult.data.state,
      });

      return reply.send(taskListResponseSchema.parse({ tasks: tasks.map(scheduledTaskResponse) }));
    } catch (error) {
      return reply.status(400).send(dependencies.errorResponse('task_list_error', dependencies.toErrorMessage(error)));
    }
  });

  app.get('/v1/tasks/:task_id', async (request, reply) => {
    const scheduledTaskService = dependencies.scheduledTaskService;
    if (!scheduledTaskService) {
      return reply
        .status(501)
        .send(dependencies.errorResponse('tasks_unavailable', 'scheduled task service is not configured'));
    }

    const paramsResult = taskParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_task_id', paramsResult.error.issues[0]?.message));
    }

    const task = await scheduledTaskService.getTask(paramsResult.data.task_id);
    if (!task) {
      return reply
        .status(404)
        .send(dependencies.errorResponse('task_not_found', `task ${paramsResult.data.task_id} not found`));
    }

    return reply.send(taskResponseSchema.parse({ task: scheduledTaskResponse(task) }));
  });

  app.patch('/v1/tasks/:task_id', async (request, reply) => {
    const scheduledTaskService = dependencies.scheduledTaskService;
    if (!scheduledTaskService) {
      return reply
        .status(501)
        .send(dependencies.errorResponse('tasks_unavailable', 'scheduled task service is not configured'));
    }

    const paramsResult = taskParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_task_id', paramsResult.error.issues[0]?.message));
    }

    const bodyResult = updateTaskRequestSchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_task_payload', bodyResult.error.issues[0]?.message));
    }

    try {
      const updated = await scheduledTaskService.updateTask(paramsResult.data.task_id, {
        title: bodyResult.data.title,
        instructions: bodyResult.data.instructions,
        enabled: bodyResult.data.enabled,
        schedule: bodyResult.data.schedule
          ? bodyResult.data.schedule.kind === 'once'
            ? {
                kind: 'once',
                onceAt: bodyResult.data.schedule.once_at,
                timezone: bodyResult.data.schedule.timezone,
              }
            : bodyResult.data.schedule.kind === 'cron'
              ? {
                  kind: 'cron',
                  cronExpr: bodyResult.data.schedule.cron,
                  timezone: bodyResult.data.schedule.timezone,
                }
              : {
                  kind: 'rrule',
                  rruleExpr: bodyResult.data.schedule.rrule,
                  timezone: bodyResult.data.schedule.timezone,
                }
          : undefined,
      });

      if (!updated) {
        return reply
          .status(404)
          .send(dependencies.errorResponse('task_not_found', `task ${paramsResult.data.task_id} not found`));
      }

      return reply.send(
        taskResponseSchema.parse({
          task: scheduledTaskResponse(updated.task),
          warnings: updated.warnings.length > 0 ? updated.warnings : undefined,
        }),
      );
    } catch (error) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('task_update_error', dependencies.toErrorMessage(error)));
    }
  });

  app.delete('/v1/tasks/:task_id', async (request, reply) => {
    const scheduledTaskService = dependencies.scheduledTaskService;
    if (!scheduledTaskService) {
      return reply
        .status(501)
        .send(dependencies.errorResponse('tasks_unavailable', 'scheduled task service is not configured'));
    }

    const paramsResult = taskParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_task_id', paramsResult.error.issues[0]?.message));
    }

    const deleted = await scheduledTaskService.deleteTask(paramsResult.data.task_id);
    if (!deleted) {
      return reply
        .status(404)
        .send(dependencies.errorResponse('task_not_found', `task ${paramsResult.data.task_id} not found`));
    }

    return reply.send(deleteTaskResponseSchema.parse({ deleted: true }));
  });

  app.post('/v1/tasks/:task_id/run-now', async (request, reply) => {
    const scheduledTaskService = dependencies.scheduledTaskService;
    if (!scheduledTaskService) {
      return reply
        .status(501)
        .send(dependencies.errorResponse('tasks_unavailable', 'scheduled task service is not configured'));
    }

    const paramsResult = taskParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('invalid_task_id', paramsResult.error.issues[0]?.message));
    }

    try {
      const result = await scheduledTaskService.runNow(paramsResult.data.task_id);
      if (!result) {
        return reply
          .status(404)
          .send(dependencies.errorResponse('task_not_found', `task ${paramsResult.data.task_id} not found`));
      }

      return reply.send(
        runNowTaskResponseSchema.parse({
          task: scheduledTaskResponse(result.task),
          task_run: scheduledTaskRunResponse(result.taskRun),
        }),
      );
    } catch (error) {
      return reply
        .status(400)
        .send(dependencies.errorResponse('task_run_now_error', dependencies.toErrorMessage(error)));
    }
  });
}

function scheduledTaskResponse(task: ScheduledTaskRecord) {
  return {
    task_id: task.taskId,
    title: task.title,
    instructions: task.instructions,
    schedule: {
      kind: task.scheduleKind,
      once_at: task.onceAt,
      cron: task.cronExpr,
      rrule: task.rruleExpr,
      timezone: task.timezone,
    },
    enabled: task.enabled,
    next_run_at: task.nextRunAt,
    creator_thread_key: task.creatorThreadKey,
    owner_user_key: task.ownerUserKey,
    delivery_target: task.deliveryTarget,
    execution_thread_key: task.executionThreadKey,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    last_run_at: task.lastRunAt,
    last_run_status: task.lastRunStatus,
    last_error_message: task.lastErrorMessage,
  };
}

function scheduledTaskRunResponse(taskRun: ScheduledTaskRunRecord) {
  return {
    task_run_id: taskRun.taskRunId,
    task_id: taskRun.taskId,
    scheduled_for: taskRun.scheduledFor,
    idempotency_key: taskRun.idempotencyKey,
    run_id: taskRun.runId,
    status: taskRun.status,
    error_message: taskRun.errorMessage,
    created_at: taskRun.createdAt,
    updated_at: taskRun.updatedAt,
  };
}
