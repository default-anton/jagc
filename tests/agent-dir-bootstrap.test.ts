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

    const gitignoreContent = await readFile(join(workspaceDir, '.gitignore'), 'utf8');
    expect(gitignoreContent).toBe('.sessions/\nauth.json\ngit/\n');
  });

  test('keeps existing workspace directory and still writes workspace ignores', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-bootstrap-'));
    tempDirs.push(root);

    const workspaceDir = join(root, 'workspace');
    await mkdir(workspaceDir, { recursive: true, mode: 0o700 });

    const result = await bootstrapAgentDir(workspaceDir);

    expect(result).toEqual({
      createdDirectory: false,
    });

    const gitignoreContent = await readFile(join(workspaceDir, '.gitignore'), 'utf8');
    expect(gitignoreContent).toBe('.sessions/\nauth.json\ngit/\n');
  });

  test('appends missing workspace ignore entries without duplicating existing ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-bootstrap-'));
    tempDirs.push(root);

    const workspaceDir = join(root, 'workspace');
    await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    await writeFile(join(workspaceDir, '.gitignore'), 'node_modules/\nauth.json\n');

    await bootstrapAgentDir(workspaceDir);

    const gitignoreContent = await readFile(join(workspaceDir, '.gitignore'), 'utf8');
    expect(gitignoreContent).toBe('node_modules/\nauth.json\n.sessions/\ngit/\n');
  });
});
