import { afterEach, describe, expect, test, vi } from 'vitest';

import { waitForRun } from '../src/cli/client.js';

describe('waitForRun', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('validates timeout before polling', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(waitForRun('http://127.0.0.1:31415', 'run-1', 0, 500)).rejects.toThrow('invalid timeoutMs: 0');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('validates interval before polling', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(waitForRun('http://127.0.0.1:31415', 'run-1', 10_000, Number.NaN)).rejects.toThrow(
      'invalid intervalMs: NaN',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
