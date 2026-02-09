import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { bootstrapAgentDir } from '../src/runtime/agent-dir-bootstrap.js';

const defaultSystemTemplatePath = resolve(process.cwd(), 'defaults', 'SYSTEM.md');
const defaultAgentsTemplatePath = resolve(process.cwd(), 'defaults', 'AGENTS.md');

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
      createdFiles: ['SYSTEM.md', 'AGENTS.md'],
    });

    const mode = (await stat(workspaceDir)).mode & 0o777;
    expect(mode).toBe(0o700);

    const gitignoreContent = await readFile(join(workspaceDir, '.gitignore'), 'utf8');
    expect(gitignoreContent).toBe('.sessions/\nauth.json\ngit/\n');

    const [expectedSystemContent, expectedAgentsContent] = await Promise.all([
      readFile(defaultSystemTemplatePath, 'utf8'),
      readFile(defaultAgentsTemplatePath, 'utf8'),
    ]);

    const [systemContent, agentsContent] = await Promise.all([
      readFile(join(workspaceDir, 'SYSTEM.md'), 'utf8'),
      readFile(join(workspaceDir, 'AGENTS.md'), 'utf8'),
    ]);

    expect(systemContent).toBe(expectedSystemContent);
    expect(agentsContent).toBe(expectedAgentsContent);
  });

  test('keeps existing workspace directory and still writes workspace defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-bootstrap-'));
    tempDirs.push(root);

    const workspaceDir = join(root, 'workspace');
    await mkdir(workspaceDir, { recursive: true, mode: 0o700 });

    const result = await bootstrapAgentDir(workspaceDir);

    expect(result).toEqual({
      createdDirectory: false,
      createdFiles: ['SYSTEM.md', 'AGENTS.md'],
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

  test('does not overwrite existing SYSTEM.md and AGENTS.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-bootstrap-'));
    tempDirs.push(root);

    const workspaceDir = join(root, 'workspace');
    await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    await writeFile(join(workspaceDir, 'SYSTEM.md'), '# SYSTEM\n\nCustom system prompt.\n');
    await writeFile(join(workspaceDir, 'AGENTS.md'), '# AGENTS\n\nCustom user profile.\n');

    const result = await bootstrapAgentDir(workspaceDir);

    expect(result).toEqual({
      createdDirectory: false,
      createdFiles: [],
    });

    const systemContent = await readFile(join(workspaceDir, 'SYSTEM.md'), 'utf8');
    expect(systemContent).toBe('# SYSTEM\n\nCustom system prompt.\n');

    const agentsContent = await readFile(join(workspaceDir, 'AGENTS.md'), 'utf8');
    expect(agentsContent).toBe('# AGENTS\n\nCustom user profile.\n');
  });
});
