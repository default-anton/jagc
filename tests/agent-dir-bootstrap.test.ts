import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
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

  test('creates workspace directory when missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-bootstrap-'));
    tempDirs.push(root);

    const workspaceDir = join(root, 'workspace');

    const result = await bootstrapAgentDir(workspaceDir);

    expect(result).toEqual({
      createdDirectory: true,
    });

    const mode = (await stat(workspaceDir)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test('keeps existing workspace directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-bootstrap-'));
    tempDirs.push(root);

    const workspaceDir = join(root, 'workspace');
    await mkdir(workspaceDir, { recursive: true, mode: 0o700 });

    const result = await bootstrapAgentDir(workspaceDir);

    expect(result).toEqual({
      createdDirectory: false,
    });
  });
});
