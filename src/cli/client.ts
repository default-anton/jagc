import { setTimeout as sleep } from 'node:timers/promises';

import {
  type AuthProvidersResponse,
  authProvidersResponseSchema,
  type PostMessageRequest,
  type RunResponse,
  runResponseSchema,
} from '../shared/api-contracts.js';

export type ApiRunResponse = RunResponse;
export type ApiAuthProvidersResponse = AuthProvidersResponse;
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
