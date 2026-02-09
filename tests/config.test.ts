import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { loadConfig } from '../src/shared/config.js';

describe('loadConfig', () => {
  test('defaults workspace and sqlite database path under ~/.jagc', () => {
    const config = loadConfig({});

    expect(config.JAGC_WORKSPACE_DIR).toBe(join(homedir(), '.jagc'));
    expect(config.JAGC_DATABASE_PATH).toBe(join(homedir(), '.jagc', 'jagc.sqlite'));
    expect(config.JAGC_HOST).toBe('127.0.0.1');
    expect(config.JAGC_RUNNER).toBe('pi');
  });

  test('expands ~ for workspace and database paths', () => {
    const config = loadConfig({
      JAGC_WORKSPACE_DIR: '~/workspace',
      JAGC_DATABASE_PATH: '~/.jagc/custom.sqlite',
      JAGC_HOST: '0.0.0.0',
      JAGC_RUNNER: 'echo',
      PI_CODING_AGENT_DIR: '~/.ignored',
    });

    expect(config.JAGC_WORKSPACE_DIR).toBe(join(homedir(), 'workspace'));
    expect(config.JAGC_DATABASE_PATH).toBe(join(homedir(), '.jagc', 'custom.sqlite'));
    expect(config.JAGC_HOST).toBe('0.0.0.0');
    expect(config.JAGC_RUNNER).toBe('echo');
    expect(config.JAGC_TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(Object.hasOwn(config, 'PI_CODING_AGENT_DIR')).toBe(false);
  });

  test('resolves relative database paths under workspace directory', () => {
    const config = loadConfig({
      JAGC_WORKSPACE_DIR: '/tmp/jagc-workspace',
      JAGC_DATABASE_PATH: 'state/jagc.sqlite',
    });

    expect(config.JAGC_DATABASE_PATH).toBe('/tmp/jagc-workspace/state/jagc.sqlite');
  });
});
