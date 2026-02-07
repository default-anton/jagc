import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { loadConfig } from '../src/shared/config.js';

describe('loadConfig', () => {
  test('defaults JAGC_WORKSPACE_DIR to ~/.jagc', () => {
    const config = loadConfig({
      JAGC_DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/jagc',
    });

    expect(config.JAGC_WORKSPACE_DIR).toBe(join(homedir(), '.jagc'));
    expect(config.JAGC_HOST).toBe('127.0.0.1');
    expect(config.JAGC_RUNNER).toBe('pi');
  });

  test('expands ~ for JAGC_WORKSPACE_DIR', () => {
    const config = loadConfig({
      JAGC_DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/jagc',
      JAGC_WORKSPACE_DIR: '~/workspace',
      JAGC_HOST: '0.0.0.0',
      JAGC_RUNNER: 'echo',
      PI_CODING_AGENT_DIR: '~/.ignored',
    });

    expect(config.JAGC_WORKSPACE_DIR).toBe(join(homedir(), 'workspace'));
    expect(config.JAGC_HOST).toBe('0.0.0.0');
    expect(config.JAGC_RUNNER).toBe('echo');
    expect(Object.hasOwn(config, 'PI_CODING_AGENT_DIR')).toBe(false);
  });
});
