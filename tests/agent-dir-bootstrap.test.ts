import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { bootstrapAgentDir } from '../src/runtime/agent-dir-bootstrap.js';

describe('bootstrapAgentDir', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test('copies settings and auth when destination files are missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-bootstrap-'));
    tempDirs.push(root);

    const legacyDir = join(root, 'legacy');
    const targetDir = join(root, 'target');

    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, 'settings.json'), '{"defaultProvider":"openai"}');
    await writeFile(join(legacyDir, 'auth.json'), '{"openai":{"type":"api_key","key":"x"}}');

    const result = await bootstrapAgentDir(targetDir, {
      legacyAgentDir: legacyDir,
    });

    expect(result).toEqual({
      copiedSettings: true,
      copiedAuth: true,
    });

    expect(await readFile(join(targetDir, 'settings.json'), 'utf8')).toContain('defaultProvider');
    expect(await readFile(join(targetDir, 'auth.json'), 'utf8')).toContain('openai');

    const authMode = (await stat(join(targetDir, 'auth.json'))).mode & 0o777;
    expect(authMode).toBe(0o600);
  });

  test('does not overwrite existing destination files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-bootstrap-'));
    tempDirs.push(root);

    const legacyDir = join(root, 'legacy');
    const targetDir = join(root, 'target');

    await mkdir(legacyDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });

    await writeFile(join(legacyDir, 'settings.json'), '{"defaultProvider":"openai"}');
    await writeFile(join(legacyDir, 'auth.json'), '{"openai":{"type":"api_key","key":"x"}}');

    await writeFile(join(targetDir, 'settings.json'), '{"defaultProvider":"anthropic"}');
    await writeFile(join(targetDir, 'auth.json'), '{"anthropic":{"type":"api_key","key":"y"}}');

    const result = await bootstrapAgentDir(targetDir, {
      legacyAgentDir: legacyDir,
    });

    expect(result).toEqual({
      copiedSettings: false,
      copiedAuth: false,
    });

    expect(await readFile(join(targetDir, 'settings.json'), 'utf8')).toContain('anthropic');
    expect(await readFile(join(targetDir, 'auth.json'), 'utf8')).toContain('anthropic');
  });
});
