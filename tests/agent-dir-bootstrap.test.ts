import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { bootstrapAgentDir } from '../src/runtime/agent-dir-bootstrap.js';

const defaultTemplatesRoot = resolve(process.cwd(), 'defaults');
const defaultSystemTemplatePath = resolve(defaultTemplatesRoot, 'SYSTEM.md');
const defaultAgentsTemplatePath = resolve(defaultTemplatesRoot, 'AGENTS.md');
const defaultSettingsTemplatePath = resolve(defaultTemplatesRoot, 'settings.json');
const defaultAgentBrowserSkillTemplatePath = resolve(defaultTemplatesRoot, 'skills', 'agent-browser', 'SKILL.md');
const defaultAgentBrowserAgentsTemplatePath = resolve(defaultTemplatesRoot, 'skills', 'agent-browser', 'AGENTS.md');
const defaultAgentBrowserTemplateScriptPath = resolve(
  defaultTemplatesRoot,
  'skills',
  'agent-browser',
  'templates',
  'form-automation.sh',
);
const defaultWorkspaceTemplateFiles = ['SYSTEM.md', 'AGENTS.md', 'settings.json'] as const;
const defaultWorkspaceTemplateDirectories = ['skills', 'extensions'] as const;

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
    const expectedCreatedFiles = await expectedBootstrapCreatedFiles();

    expect(result).toEqual({
      createdDirectory: true,
      createdFiles: expectedCreatedFiles,
    });

    const mode = (await stat(workspaceDir)).mode & 0o777;
    expect(mode).toBe(0o700);

    const gitDirectoryStat = await stat(join(workspaceDir, '.git'));
    expect(gitDirectoryStat.isDirectory()).toBe(true);

    const gitignoreContent = await readFile(join(workspaceDir, '.gitignore'), 'utf8');
    expect(gitignoreContent).toBe('.sessions/\nauth.json\ngit/\njagc.sqlite\njagc.sqlite-shm\njagc.sqlite-wal\n');

    const [expectedSystemContent, expectedAgentsContent, expectedSettingsContent] = await Promise.all([
      readFile(defaultSystemTemplatePath, 'utf8'),
      readFile(defaultAgentsTemplatePath, 'utf8'),
      readFile(defaultSettingsTemplatePath, 'utf8'),
    ]);

    const [systemContent, agentsContent, settingsContent] = await Promise.all([
      readFile(join(workspaceDir, 'SYSTEM.md'), 'utf8'),
      readFile(join(workspaceDir, 'AGENTS.md'), 'utf8'),
      readFile(join(workspaceDir, 'settings.json'), 'utf8'),
    ]);

    expect(systemContent).toBe(expectedSystemContent);
    expect(agentsContent).toBe(expectedAgentsContent);
    expect(settingsContent).toBe(expectedSettingsContent);

    const [expectedAgentBrowserSkill, expectedAgentBrowserAgents] = await Promise.all([
      readFile(defaultAgentBrowserSkillTemplatePath, 'utf8'),
      readFile(defaultAgentBrowserAgentsTemplatePath, 'utf8'),
    ]);

    const [agentBrowserSkill, agentBrowserAgents] = await Promise.all([
      readFile(join(workspaceDir, 'skills', 'agent-browser', 'SKILL.md'), 'utf8'),
      readFile(join(workspaceDir, 'skills', 'agent-browser', 'AGENTS.md'), 'utf8'),
    ]);

    expect(agentBrowserSkill).toBe(expectedAgentBrowserSkill);
    expect(agentBrowserAgents).toBe(expectedAgentBrowserAgents);

    const expectedTemplateScriptMode = (await stat(defaultAgentBrowserTemplateScriptPath)).mode & 0o777;
    const installedTemplateScriptMode =
      (await stat(join(workspaceDir, 'skills', 'agent-browser', 'templates', 'form-automation.sh'))).mode & 0o777;
    expect(installedTemplateScriptMode).toBe(expectedTemplateScriptMode);
  });

  test('keeps existing workspace directory and still writes workspace defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-bootstrap-'));
    tempDirs.push(root);

    const workspaceDir = join(root, 'workspace');
    await mkdir(workspaceDir, { recursive: true, mode: 0o700 });

    const result = await bootstrapAgentDir(workspaceDir);
    const expectedCreatedFiles = await expectedBootstrapCreatedFiles();

    expect(result).toEqual({
      createdDirectory: false,
      createdFiles: expectedCreatedFiles,
    });

    const gitDirectoryStat = await stat(join(workspaceDir, '.git'));
    expect(gitDirectoryStat.isDirectory()).toBe(true);

    const gitignoreContent = await readFile(join(workspaceDir, '.gitignore'), 'utf8');
    expect(gitignoreContent).toBe('.sessions/\nauth.json\ngit/\njagc.sqlite\njagc.sqlite-shm\njagc.sqlite-wal\n');
  });

  test('appends missing workspace ignore entries without duplicating existing ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-bootstrap-'));
    tempDirs.push(root);

    const workspaceDir = join(root, 'workspace');
    await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    await writeFile(join(workspaceDir, '.gitignore'), 'node_modules/\nauth.json\n');

    await bootstrapAgentDir(workspaceDir);

    const gitignoreContent = await readFile(join(workspaceDir, '.gitignore'), 'utf8');
    expect(gitignoreContent).toBe(
      'node_modules/\nauth.json\n.sessions/\ngit/\njagc.sqlite\njagc.sqlite-shm\njagc.sqlite-wal\n',
    );
  });

  test('does not overwrite existing SYSTEM.md, AGENTS.md, and settings.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-bootstrap-'));
    tempDirs.push(root);

    const workspaceDir = join(root, 'workspace');
    await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
    await writeFile(join(workspaceDir, 'SYSTEM.md'), '# SYSTEM\n\nCustom system prompt.\n');
    await writeFile(join(workspaceDir, 'AGENTS.md'), '# AGENTS\n\nCustom user profile.\n');
    await writeFile(join(workspaceDir, 'settings.json'), '{"packages":[]}\n');

    const result = await bootstrapAgentDir(workspaceDir);

    expect(result).toEqual({
      createdDirectory: false,
      createdFiles: await expectedBundledTemplateFiles(),
    });

    const systemContent = await readFile(join(workspaceDir, 'SYSTEM.md'), 'utf8');
    expect(systemContent).toBe('# SYSTEM\n\nCustom system prompt.\n');

    const agentsContent = await readFile(join(workspaceDir, 'AGENTS.md'), 'utf8');
    expect(agentsContent).toBe('# AGENTS\n\nCustom user profile.\n');

    const settingsContent = await readFile(join(workspaceDir, 'settings.json'), 'utf8');
    expect(settingsContent).toBe('{"packages":[]}\n');
  });

  test('does not overwrite an existing bundled skill file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-bootstrap-'));
    tempDirs.push(root);

    const workspaceDir = join(root, 'workspace');
    await mkdir(join(workspaceDir, 'skills', 'agent-browser'), { recursive: true, mode: 0o700 });
    await writeFile(join(workspaceDir, 'skills', 'agent-browser', 'SKILL.md'), '# custom\n');

    const result = await bootstrapAgentDir(workspaceDir);

    expect(result.createdFiles).not.toContain('skills/agent-browser/SKILL.md');

    const skillContent = await readFile(join(workspaceDir, 'skills', 'agent-browser', 'SKILL.md'), 'utf8');
    expect(skillContent).toBe('# custom\n');

    const bundledAgentsContent = await readFile(join(workspaceDir, 'skills', 'agent-browser', 'AGENTS.md'), 'utf8');
    const expectedBundledAgentsContent = await readFile(defaultAgentBrowserAgentsTemplatePath, 'utf8');
    expect(bundledAgentsContent).toBe(expectedBundledAgentsContent);
  });
});

async function expectedBootstrapCreatedFiles(): Promise<string[]> {
  const bundledFiles = await expectedBundledTemplateFiles();
  return [...defaultWorkspaceTemplateFiles, ...bundledFiles];
}

async function expectedBundledTemplateFiles(): Promise<string[]> {
  const files: string[] = [];

  for (const directory of defaultWorkspaceTemplateDirectories) {
    const sourceDirectory = resolve(defaultTemplatesRoot, directory);
    if (!(await exists(sourceDirectory))) {
      continue;
    }

    const directoryFiles = await listTemplateFilesRecursively(sourceDirectory, directory);
    files.push(...directoryFiles);
  }

  return files;
}

async function listTemplateFilesRecursively(sourceDirectory: string, relativePath: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const childSourcePath = join(sourceDirectory, entry.name);
    const childRelativePath = posix.join(relativePath, entry.name);

    if (entry.isDirectory()) {
      const nestedFiles = await listTemplateFilesRecursively(childSourcePath, childRelativePath);
      files.push(...nestedFiles);
      continue;
    }

    if (entry.isFile()) {
      files.push(childRelativePath);
    }
  }

  return files;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
