import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, chmod, copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AgentDirBootstrapResult {
  createdDirectory: boolean;
  createdFiles: string[];
}

export interface AgentDirBootstrapOptions {
  overwriteExistingFiles?: boolean;
  overwriteWorkspaceFiles?: boolean;
  overwriteBundledFiles?: boolean;
  overwriteWorkspaceFilesExclude?: string[];
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const workspaceGitignoreEntries = [
  '.sessions/',
  'auth.json',
  'git/',
  'service.env',
  'service.env.snapshot',
  'jagc.sqlite',
  'jagc.sqlite-shm',
  'jagc.sqlite-wal',
];
const defaultsRoot = resolveDefaultsRoot();
const defaultWorkspaceFiles = [
  {
    name: 'SYSTEM.md',
    templatePath: workspaceTemplatePath('SYSTEM.md'),
  },
  {
    name: 'AGENTS.md',
    templatePath: workspaceTemplatePath('AGENTS.md'),
  },
  {
    name: 'settings.json',
    templatePath: workspaceTemplatePath('settings.json'),
  },
] as const;
const defaultWorkspaceDirectories = ['skills', 'extensions', 'memory'] as const;

export async function bootstrapAgentDir(
  agentDir: string,
  options: AgentDirBootstrapOptions = {},
): Promise<AgentDirBootstrapResult> {
  const overwriteWorkspaceFiles = options.overwriteWorkspaceFiles ?? options.overwriteExistingFiles ?? false;
  const overwriteBundledFiles = options.overwriteBundledFiles ?? options.overwriteExistingFiles ?? false;
  const overwriteWorkspaceFilesExclude = new Set(options.overwriteWorkspaceFilesExclude ?? []);
  const createdDirectory = !(await exists(agentDir));
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await ensureWorkspaceGitRepository(agentDir);
  await ensureWorkspaceGitignore(agentDir);
  const createdFiles = await ensureDefaultWorkspaceFiles(
    agentDir,
    overwriteWorkspaceFiles,
    overwriteWorkspaceFilesExclude,
  );
  const createdBundledFiles = await ensureDefaultWorkspaceDirectories(agentDir, overwriteBundledFiles);

  return {
    createdDirectory,
    createdFiles: [...createdFiles, ...createdBundledFiles],
  };
}

async function ensureWorkspaceGitRepository(agentDir: string): Promise<void> {
  if (await exists(join(agentDir, '.git'))) {
    return;
  }

  const initResult = await runCommand('git', ['-C', agentDir, 'init']);
  if (initResult.code === 0) {
    return;
  }

  throw new Error(
    `failed to initialize workspace git repository at ${agentDir}: ${initResult.stderr || initResult.stdout || `exit ${initResult.code}`}`,
  );
}

async function ensureWorkspaceGitignore(agentDir: string): Promise<void> {
  const gitignorePath = join(agentDir, '.gitignore');
  const existingContent = await readIfExists(gitignorePath);

  if (existingContent === undefined) {
    await writeFile(gitignorePath, `${workspaceGitignoreEntries.join('\n')}\n`);
    return;
  }

  const existingEntries = new Set(existingContent.split(/\r?\n/).map((line) => line.trim()));
  const missingEntries = workspaceGitignoreEntries.filter((entry) => !existingEntries.has(entry));

  if (missingEntries.length === 0) {
    return;
  }

  const separator = existingContent.endsWith('\n') || existingContent.length === 0 ? '' : '\n';
  await writeFile(gitignorePath, `${existingContent}${separator}${missingEntries.join('\n')}\n`);
}

async function ensureDefaultWorkspaceFiles(
  agentDir: string,
  overwriteExistingFiles: boolean,
  overwriteExclude: Set<string>,
): Promise<string[]> {
  const createdFiles: string[] = [];

  for (const file of defaultWorkspaceFiles) {
    const filePath = join(agentDir, file.name);
    const existingContent = await readIfExists(filePath);
    const shouldSkipOverwrite =
      existingContent !== undefined && (!overwriteExistingFiles || overwriteExclude.has(file.name));

    if (shouldSkipOverwrite) {
      continue;
    }

    const templateContent = await readWorkspaceTemplate(file.templatePath);
    await writeFile(filePath, templateContent);
    createdFiles.push(file.name);
  }

  return createdFiles;
}

async function ensureDefaultWorkspaceDirectories(agentDir: string, overwriteExistingFiles: boolean): Promise<string[]> {
  const createdFiles: string[] = [];

  for (const directory of defaultWorkspaceDirectories) {
    const sourceDirectoryPath = workspaceTemplatePath(directory);
    if (!(await exists(sourceDirectoryPath))) {
      continue;
    }

    const targetDirectoryPath = join(agentDir, directory);
    await mkdir(targetDirectoryPath, { recursive: true, mode: 0o700 });

    const copiedFiles = await copyMissingFilesRecursively({
      sourceDirectoryPath,
      targetDirectoryPath,
      relativePath: directory,
      overwriteExistingFiles,
    });

    createdFiles.push(...copiedFiles);
  }

  return createdFiles;
}

async function copyMissingFilesRecursively(options: {
  sourceDirectoryPath: string;
  targetDirectoryPath: string;
  relativePath: string;
  overwriteExistingFiles: boolean;
}): Promise<string[]> {
  const createdFiles: string[] = [];
  const entries = await readdir(options.sourceDirectoryPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const sourcePath = join(options.sourceDirectoryPath, entry.name);
    const targetPath = join(options.targetDirectoryPath, entry.name);
    const relativePath = posix.join(options.relativePath, entry.name);

    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true, mode: 0o700 });
      const nestedCreatedFiles = await copyMissingFilesRecursively({
        sourceDirectoryPath: sourcePath,
        targetDirectoryPath: targetPath,
        relativePath,
        overwriteExistingFiles: options.overwriteExistingFiles,
      });
      createdFiles.push(...nestedCreatedFiles);
      continue;
    }

    if (!entry.isFile()) {
      throw new Error(`workspace bootstrap template contains unsupported entry: ${sourcePath}`);
    }

    if (!options.overwriteExistingFiles && (await exists(targetPath))) {
      continue;
    }

    await copyFile(sourcePath, targetPath);
    const sourceMode = (await stat(sourcePath)).mode & 0o777;
    await chmod(targetPath, sourceMode);
    createdFiles.push(relativePath);
  }

  return createdFiles;
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      stderr += `${error.message}`;
    });

    child.on('close', (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

async function readWorkspaceTemplate(templatePath: string): Promise<string> {
  const templateContent = await readIfExists(templatePath);

  if (templateContent !== undefined) {
    return templateContent;
  }

  throw new Error(`workspace bootstrap template is missing: ${templatePath}`);
}

function workspaceTemplatePath(templateFile: string): string {
  return join(defaultsRoot, templateFile);
}

function resolveDefaultsRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const fallbackCandidate = resolve(moduleDir, '../../defaults');
  const directCandidates = [fallbackCandidate, resolve(moduleDir, '../defaults')];

  for (const candidate of directCandidates) {
    if (existsSync(join(candidate, 'SYSTEM.md'))) {
      return candidate;
    }
  }

  let currentDir = moduleDir;
  for (let index = 0; index < 8; index += 1) {
    const candidate = resolve(currentDir, 'defaults');
    if (existsSync(join(candidate, 'SYSTEM.md'))) {
      return candidate;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return fallbackCandidate;
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
