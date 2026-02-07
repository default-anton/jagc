export type TelegramCallbackAction =
  | { kind: 'settings_open' }
  | { kind: 'settings_refresh' }
  | { kind: 'model_providers'; page: number }
  | { kind: 'model_list'; provider: string; page: number }
  | { kind: 'model_set'; provider: string; modelId: string; page: number }
  | { kind: 'thinking_list' }
  | { kind: 'thinking_set'; thinkingLevel: string };

export function parseTelegramCallbackData(data: string): TelegramCallbackAction | null {
  if (data === 's:open') {
    return { kind: 'settings_open' };
  }

  if (data === 's:refresh') {
    return { kind: 'settings_refresh' };
  }

  if (data === 't:list') {
    return { kind: 'thinking_list' };
  }

  const segments = data.split(':');
  if (segments[0] === 'm' && segments[1] === 'providers' && segments.length === 3) {
    const page = parseNonNegativeInteger(segments[2]);
    if (page === null) {
      return null;
    }

    return { kind: 'model_providers', page };
  }

  if (segments[0] === 'm' && segments[1] === 'list' && segments.length === 4) {
    const provider = decodeSegment(segments[2]);
    const page = parseNonNegativeInteger(segments[3]);
    if (!provider || page === null) {
      return null;
    }

    return { kind: 'model_list', provider, page };
  }

  if (segments[0] === 'm' && segments[1] === 'set' && segments.length === 5) {
    const provider = decodeSegment(segments[2]);
    const modelId = decodeSegment(segments[3]);
    const page = parseNonNegativeInteger(segments[4]);
    if (!provider || !modelId || page === null) {
      return null;
    }

    return { kind: 'model_set', provider, modelId, page };
  }

  if (segments[0] === 't' && segments[1] === 'set' && segments.length === 3) {
    const thinkingLevel = decodeSegment(segments[2]);
    if (!thinkingLevel) {
      return null;
    }

    return { kind: 'thinking_set', thinkingLevel };
  }

  return null;
}

export function callbackModelProviders(page: number): string {
  return `m:providers:${page}`;
}

export function callbackModelList(provider: string, page: number): string {
  return `m:list:${encodeSegment(provider)}:${page}`;
}

export function callbackModelSet(provider: string, modelId: string, page: number): string {
  return `m:set:${encodeSegment(provider)}:${encodeSegment(modelId)}:${page}`;
}

export function callbackThinkingSet(level: string): string {
  return `t:set:${encodeSegment(level)}`;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function decodeSegment(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }

  return parsed;
}
