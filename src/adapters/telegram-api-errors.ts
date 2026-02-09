export function isTelegramMessageNotModifiedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.toLowerCase().includes('message is not modified');
}

export function extractTelegramRetryAfterSeconds(error: unknown): number | null {
  const retryAfter = extractRetryAfterFromObject(error);
  if (retryAfter !== null) {
    return retryAfter;
  }

  if (!(error instanceof Error)) {
    return null;
  }

  const messageMatch = error.message.match(/retry after\s+(\d+(?:\.\d+)?)/i);
  if (!messageMatch) {
    return null;
  }

  const parsed = Number(messageMatch[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function extractRetryAfterFromObject(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const value = error as Record<string, unknown>;
  const direct = extractRetryAfterValue(value.parameters);
  if (direct !== null) {
    return direct;
  }

  const response = value.response;
  if (response && typeof response === 'object') {
    const responseObject = response as Record<string, unknown>;
    const fromResponseParameters = extractRetryAfterValue(responseObject.parameters);
    if (fromResponseParameters !== null) {
      return fromResponseParameters;
    }

    const fromResponseBody = extractRetryAfterValue(responseObject.body);
    if (fromResponseBody !== null) {
      return fromResponseBody;
    }
  }

  const payload = value.payload;
  if (payload && typeof payload === 'object') {
    const payloadObject = payload as Record<string, unknown>;
    const fromPayloadParameters = extractRetryAfterValue(payloadObject.parameters);
    if (fromPayloadParameters !== null) {
      return fromPayloadParameters;
    }
  }

  return null;
}

function extractRetryAfterValue(value: unknown): number | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const retryAfter = (value as Record<string, unknown>).retry_after;
  if (typeof retryAfter !== 'number' || !Number.isFinite(retryAfter) || retryAfter <= 0) {
    return null;
  }

  return retryAfter;
}
