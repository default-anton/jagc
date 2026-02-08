import { setTimeout as sleep } from 'node:timers/promises';

import {
  type AuthProvidersResponse,
  authProvidersResponseSchema,
  type ModelCatalogResponse,
  modelCatalogResponseSchema,
  type OAuthLoginAttemptResponse,
  oauthLoginAttemptSchema,
  oauthOwnerHeaderName,
  type PostMessageRequest,
  type ResetThreadSessionResponse,
  type RunResponse,
  resetThreadSessionResponseSchema,
  runResponseSchema,
  type SetThreadModelRequest,
  type SetThreadThinkingRequest,
  type SubmitOAuthLoginInputRequest,
  submitOAuthLoginInputRequestSchema,
  type ThreadRuntimeStateResponse,
  threadRuntimeStateSchema,
} from '../shared/api-contracts.js';

export type ApiRunResponse = RunResponse;
export type ApiAuthProvidersResponse = AuthProvidersResponse;
export type ApiModelCatalogResponse = ModelCatalogResponse;
export type ApiThreadRuntimeStateResponse = ThreadRuntimeStateResponse;
export type ApiOAuthLoginAttemptResponse = OAuthLoginAttemptResponse;
export type ApiResetThreadSessionResponse = ResetThreadSessionResponse;
export type MessageRequest = PostMessageRequest;

export async function sendMessage(apiUrl: string, payload: MessageRequest): Promise<ApiRunResponse> {
  const response = await fetch(`${apiUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return parseRunResponse(response);
}

export async function getRun(apiUrl: string, runId: string): Promise<ApiRunResponse> {
  const response = await fetch(`${apiUrl}/v1/runs/${encodeURIComponent(runId)}`);
  return parseRunResponse(response);
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
  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    const message =
      responseBody && typeof responseBody === 'object'
        ? extractErrorMessage(responseBody)
        : `request failed with status ${response.status}`;
    throw new Error(message);
  }

  return authProvidersResponseSchema.parse(responseBody);
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

  return parseOAuthLoginAttemptResponse(response);
}

export async function getOAuthLoginAttempt(
  apiUrl: string,
  attemptId: string,
  ownerKey: string,
): Promise<ApiOAuthLoginAttemptResponse> {
  const response = await fetch(`${apiUrl}/v1/auth/logins/${encodeURIComponent(attemptId)}`, {
    headers: oauthOwnerHeader(ownerKey),
  });
  return parseOAuthLoginAttemptResponse(response);
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

  return parseOAuthLoginAttemptResponse(response);
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

  return parseOAuthLoginAttemptResponse(response);
}

export async function getModelCatalog(apiUrl: string): Promise<ApiModelCatalogResponse> {
  const response = await fetch(`${apiUrl}/v1/models`);
  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    const message =
      responseBody && typeof responseBody === 'object'
        ? extractErrorMessage(responseBody)
        : `request failed with status ${response.status}`;
    throw new Error(message);
  }

  return modelCatalogResponseSchema.parse(responseBody);
}

export async function getThreadRuntime(apiUrl: string, threadKey: string): Promise<ApiThreadRuntimeStateResponse> {
  const response = await fetch(`${apiUrl}/v1/threads/${encodeURIComponent(threadKey)}/runtime`);
  return parseThreadRuntimeResponse(response);
}

export async function setThreadModel(
  apiUrl: string,
  threadKey: string,
  payload: SetThreadModelRequest,
): Promise<ApiThreadRuntimeStateResponse> {
  const response = await fetch(`${apiUrl}/v1/threads/${encodeURIComponent(threadKey)}/model`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return parseThreadRuntimeResponse(response);
}

export async function setThreadThinkingLevel(
  apiUrl: string,
  threadKey: string,
  payload: SetThreadThinkingRequest,
): Promise<ApiThreadRuntimeStateResponse> {
  const response = await fetch(`${apiUrl}/v1/threads/${encodeURIComponent(threadKey)}/thinking`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return parseThreadRuntimeResponse(response);
}

export async function resetThreadSession(apiUrl: string, threadKey: string): Promise<ApiResetThreadSessionResponse> {
  const response = await fetch(`${apiUrl}/v1/threads/${encodeURIComponent(threadKey)}/session`, {
    method: 'DELETE',
  });

  return parseResetThreadSessionResponse(response);
}

function oauthOwnerHeader(ownerKey: string): Record<string, string> {
  return {
    [oauthOwnerHeaderName]: ownerKey,
  };
}

async function parseRunResponse(response: Response): Promise<ApiRunResponse> {
  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    const message =
      responseBody && typeof responseBody === 'object'
        ? extractErrorMessage(responseBody)
        : `request failed with status ${response.status}`;
    throw new Error(message);
  }

  return runResponseSchema.parse(responseBody);
}

async function parseOAuthLoginAttemptResponse(response: Response): Promise<ApiOAuthLoginAttemptResponse> {
  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    const message =
      responseBody && typeof responseBody === 'object'
        ? extractErrorMessage(responseBody)
        : `request failed with status ${response.status}`;
    throw new Error(message);
  }

  return oauthLoginAttemptSchema.parse(responseBody);
}

async function parseThreadRuntimeResponse(response: Response): Promise<ApiThreadRuntimeStateResponse> {
  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    const message =
      responseBody && typeof responseBody === 'object'
        ? extractErrorMessage(responseBody)
        : `request failed with status ${response.status}`;
    throw new Error(message);
  }

  return threadRuntimeStateSchema.parse(responseBody);
}

async function parseResetThreadSessionResponse(response: Response): Promise<ApiResetThreadSessionResponse> {
  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    const message =
      responseBody && typeof responseBody === 'object'
        ? extractErrorMessage(responseBody)
        : `request failed with status ${response.status}`;
    throw new Error(message);
  }

  return resetThreadSessionResponseSchema.parse(responseBody);
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function extractErrorMessage(responseBody: object): string {
  if (!('error' in responseBody)) {
    return 'request failed';
  }

  const error = responseBody.error;
  if (!error || typeof error !== 'object') {
    return 'request failed';
  }

  return 'message' in error && typeof error.message === 'string' ? error.message : 'request failed';
}
