import { setTimeout as sleep } from 'node:timers/promises';

import {
  type AuthProvidersResponse,
  authProvidersResponseSchema,
  type CancelThreadRunResponse,
  type CreateTaskRequest,
  cancelThreadRunResponseSchema,
  deleteTaskResponseSchema,
  type ModelCatalogResponse,
  modelCatalogResponseSchema,
  type OAuthLoginAttemptResponse,
  oauthLoginAttemptSchema,
  oauthOwnerHeaderName,
  type PostMessageRequest,
  type ResetThreadSessionResponse,
  type RunNowTaskResponse,
  type RunResponse,
  resetThreadSessionResponseSchema,
  runNowTaskResponseSchema,
  runResponseSchema,
  type SetThreadModelRequest,
  type SetThreadThinkingRequest,
  type ShareThreadSessionResponse,
  type SubmitOAuthLoginInputRequest,
  shareThreadSessionResponseSchema,
  submitOAuthLoginInputRequestSchema,
  type TaskListResponse,
  type TaskResponse,
  type ThreadRuntimeStateResponse,
  taskListResponseSchema,
  taskResponseSchema,
  threadRuntimeStateSchema,
  type UpdateTaskRequest,
} from '../shared/api-contracts.js';

export type ApiRunResponse = RunResponse;
export type ApiAuthProvidersResponse = AuthProvidersResponse;
export type ApiModelCatalogResponse = ModelCatalogResponse;
export type ApiThreadRuntimeStateResponse = ThreadRuntimeStateResponse;
export type ApiOAuthLoginAttemptResponse = OAuthLoginAttemptResponse;
export type ApiCancelThreadRunResponse = CancelThreadRunResponse;
export type ApiResetThreadSessionResponse = ResetThreadSessionResponse;
export type ApiShareThreadSessionResponse = ShareThreadSessionResponse;
export type ApiTaskResponse = TaskResponse;
export type ApiTaskListResponse = TaskListResponse;
export type ApiRunNowTaskResponse = RunNowTaskResponse;
export type MessageRequest = PostMessageRequest;

export async function sendMessage(apiUrl: string, payload: MessageRequest): Promise<ApiRunResponse> {
  const response = await fetch(`${apiUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return parseApiResponse(response, runResponseSchema);
}

export async function getRun(apiUrl: string, runId: string): Promise<ApiRunResponse> {
  const response = await fetch(`${apiUrl}/v1/runs/${encodeURIComponent(runId)}`);
  return parseApiResponse(response, runResponseSchema);
}

export async function waitForRun(
  apiUrl: string,
  runId: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<ApiRunResponse> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid timeoutMs: ${timeoutMs}`);
  }

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`invalid intervalMs: ${intervalMs}`);
  }

  const startedAt = Date.now();

  while (true) {
    const run = await getRun(apiUrl, runId);
    if (run.status !== 'running') {
      return run;
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for run ${runId}`);
    }

    await sleep(intervalMs);
  }
}

export async function healthcheck(apiUrl: string): Promise<void> {
  const response = await fetch(`${apiUrl}/healthz`);
  if (!response.ok) {
    throw new Error(`health check failed with status ${response.status}`);
  }
}

export async function getAuthProviders(apiUrl: string): Promise<ApiAuthProvidersResponse> {
  const response = await fetch(`${apiUrl}/v1/auth/providers`);
  return parseApiResponse(response, authProvidersResponseSchema);
}

export async function startOAuthLogin(
  apiUrl: string,
  provider: string,
  ownerKey?: string,
): Promise<ApiOAuthLoginAttemptResponse> {
  const response = await fetch(`${apiUrl}/v1/auth/providers/${encodeURIComponent(provider)}/login`, {
    method: 'POST',
    headers: ownerKey ? oauthOwnerHeader(ownerKey) : undefined,
  });

  return parseApiResponse(response, oauthLoginAttemptSchema);
}

export async function getOAuthLoginAttempt(
  apiUrl: string,
  attemptId: string,
  ownerKey: string,
): Promise<ApiOAuthLoginAttemptResponse> {
  const response = await fetch(`${apiUrl}/v1/auth/logins/${encodeURIComponent(attemptId)}`, {
    headers: oauthOwnerHeader(ownerKey),
  });
  return parseApiResponse(response, oauthLoginAttemptSchema);
}

export async function submitOAuthLoginInput(
  apiUrl: string,
  attemptId: string,
  ownerKey: string,
  payload: SubmitOAuthLoginInputRequest,
): Promise<ApiOAuthLoginAttemptResponse> {
  const parsedPayload = submitOAuthLoginInputRequestSchema.parse(payload);

  const response = await fetch(`${apiUrl}/v1/auth/logins/${encodeURIComponent(attemptId)}/input`, {
    method: 'POST',
    headers: {
      ...oauthOwnerHeader(ownerKey),
      'content-type': 'application/json',
    },
    body: JSON.stringify(parsedPayload),
  });

  return parseApiResponse(response, oauthLoginAttemptSchema);
}

export async function cancelOAuthLogin(
  apiUrl: string,
  attemptId: string,
  ownerKey: string,
): Promise<ApiOAuthLoginAttemptResponse> {
  const response = await fetch(`${apiUrl}/v1/auth/logins/${encodeURIComponent(attemptId)}/cancel`, {
    method: 'POST',
    headers: oauthOwnerHeader(ownerKey),
  });

  return parseApiResponse(response, oauthLoginAttemptSchema);
}

export async function getModelCatalog(apiUrl: string): Promise<ApiModelCatalogResponse> {
  const response = await fetch(`${apiUrl}/v1/models`);
  return parseApiResponse(response, modelCatalogResponseSchema);
}

export async function getThreadRuntime(apiUrl: string, threadKey: string): Promise<ApiThreadRuntimeStateResponse> {
  const response = await fetch(`${apiUrl}/v1/threads/${encodeURIComponent(threadKey)}/runtime`);
  return parseApiResponse(response, threadRuntimeStateSchema);
}

export async function setThreadModel(
  apiUrl: string,
  threadKey: string,
  payload: SetThreadModelRequest,
): Promise<ApiThreadRuntimeStateResponse> {
  return sendJsonRequest(
    `${apiUrl}/v1/threads/${encodeURIComponent(threadKey)}/model`,
    'PUT',
    payload,
    threadRuntimeStateSchema,
  );
}

export async function setThreadThinkingLevel(
  apiUrl: string,
  threadKey: string,
  payload: SetThreadThinkingRequest,
): Promise<ApiThreadRuntimeStateResponse> {
  return sendJsonRequest(
    `${apiUrl}/v1/threads/${encodeURIComponent(threadKey)}/thinking`,
    'PUT',
    payload,
    threadRuntimeStateSchema,
  );
}

export async function cancelThreadRun(apiUrl: string, threadKey: string): Promise<ApiCancelThreadRunResponse> {
  const response = await fetch(`${apiUrl}/v1/threads/${encodeURIComponent(threadKey)}/cancel`, {
    method: 'POST',
  });

  return parseApiResponse(response, cancelThreadRunResponseSchema);
}

export async function resetThreadSession(apiUrl: string, threadKey: string): Promise<ApiResetThreadSessionResponse> {
  const response = await fetch(`${apiUrl}/v1/threads/${encodeURIComponent(threadKey)}/session`, {
    method: 'DELETE',
  });

  return parseApiResponse(response, resetThreadSessionResponseSchema);
}

export async function shareThreadSession(apiUrl: string, threadKey: string): Promise<ApiShareThreadSessionResponse> {
  const response = await fetch(`${apiUrl}/v1/threads/${encodeURIComponent(threadKey)}/share`, {
    method: 'POST',
  });

  return parseApiResponse(response, shareThreadSessionResponseSchema);
}

export async function createTask(
  apiUrl: string,
  threadKey: string,
  payload: CreateTaskRequest,
): Promise<ApiTaskResponse> {
  return sendJsonRequest(
    `${apiUrl}/v1/threads/${encodeURIComponent(threadKey)}/tasks`,
    'POST',
    payload,
    taskResponseSchema,
  );
}

export async function listTasks(
  apiUrl: string,
  options: { threadKey?: string; state?: 'all' | 'enabled' | 'disabled' } = {},
): Promise<ApiTaskListResponse> {
  const url = new URL('/v1/tasks', apiUrl);

  if (options.threadKey) {
    url.searchParams.set('thread_key', options.threadKey);
  }

  if (options.state) {
    url.searchParams.set('state', options.state);
  }

  const response = await fetch(url);
  return parseApiResponse(response, taskListResponseSchema);
}

export async function getTask(apiUrl: string, taskId: string): Promise<ApiTaskResponse> {
  const response = await fetch(`${apiUrl}/v1/tasks/${encodeURIComponent(taskId)}`);
  return parseApiResponse(response, taskResponseSchema);
}

export async function updateTask(apiUrl: string, taskId: string, payload: UpdateTaskRequest): Promise<ApiTaskResponse> {
  return sendJsonRequest(`${apiUrl}/v1/tasks/${encodeURIComponent(taskId)}`, 'PATCH', payload, taskResponseSchema);
}

export async function deleteTask(apiUrl: string, taskId: string): Promise<{ deleted: boolean }> {
  const response = await fetch(`${apiUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  });

  return parseApiResponse(response, deleteTaskResponseSchema);
}

export async function runTaskNow(apiUrl: string, taskId: string): Promise<ApiRunNowTaskResponse> {
  const response = await fetch(`${apiUrl}/v1/tasks/${encodeURIComponent(taskId)}/run-now`, {
    method: 'POST',
  });

  return parseApiResponse(response, runNowTaskResponseSchema);
}

function oauthOwnerHeader(ownerKey: string): Record<string, string> {
  return {
    [oauthOwnerHeaderName]: ownerKey,
  };
}

async function sendJsonRequest<T>(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH',
  payload: unknown,
  schema: ResponseBodySchema<T>,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return parseApiResponse(response, schema);
}

interface ResponseBodySchema<T> {
  parse(input: unknown): T;
}

async function parseApiResponse<T>(response: Response, schema: ResponseBodySchema<T>): Promise<T> {
  const responseBody = await parseJsonResponse(response);
  throwForUnexpectedResponse(response, responseBody);
  return schema.parse(responseBody);
}

function throwForUnexpectedResponse(response: Response, responseBody: unknown): void {
  if (response.ok) {
    return;
  }

  const message =
    responseBody && typeof responseBody === 'object'
      ? extractErrorMessage(responseBody)
      : `request failed with status ${response.status}`;
  throw new Error(message);
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function extractErrorMessage(responseBody: object): string {
  if (!('error' in responseBody)) {
    return 'request failed';
  }

  const errorObject = responseBody.error;
  if (!errorObject || typeof errorObject !== 'object') {
    return 'request failed';
  }

  const message = 'message' in errorObject && typeof errorObject.message === 'string' ? errorObject.message : null;
  const code = 'code' in errorObject && typeof errorObject.code === 'string' ? errorObject.code : null;

  if (code && message) {
    return `${code}: ${message}`;
  }

  if (message) {
    return message;
  }

  if (code) {
    return code;
  }

  return 'request failed';
}
