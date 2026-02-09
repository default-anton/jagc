import { access, chmod, copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AgentDirBootstrapResult {
  createdDirectory: boolean;
  createdFiles: string[];
}

const workspaceGitignoreEntries = [
  '.sessions/',
  'auth.json',
  'git/',
  'jagc.sqlite',
  'jagc.sqlite-shm',
  'jagc.sqlite-wal',
];
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
const defaultWorkspaceDirectories = ['skills', 'extensions'] as const;

export async function bootstrapAgentDir(agentDir: string): Promise<AgentDirBootstrapResult> {
  const createdDirectory = !(await exists(agentDir));
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await ensureWorkspaceGitignore(agentDir);
  const createdFiles = await ensureDefaultWorkspaceFiles(agentDir);
  const createdBundledFiles = await ensureDefaultWorkspaceDirectories(agentDir);

  return {
    createdDirectory,
    createdFiles: [...createdFiles, ...createdBundledFiles],
  };
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

async function ensureDefaultWorkspaceFiles(agentDir: string): Promise<string[]> {
  const createdFiles: string[] = [];

  for (const file of defaultWorkspaceFiles) {
    const filePath = join(agentDir, file.name);
    const existingContent = await readIfExists(filePath);

    if (existingContent !== undefined) {
      continue;
    }

    const templateContent = await readWorkspaceTemplate(file.templatePath);
    await writeFile(filePath, templateContent);
    createdFiles.push(file.name);
  }

  return createdFiles;
}

async function ensureDefaultWorkspaceDirectories(agentDir: string): Promise<string[]> {
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
    });

    createdFiles.push(...copiedFiles);
  }

  return createdFiles;
}

async function copyMissingFilesRecursively(options: {
  sourceDirectoryPath: string;
  targetDirectoryPath: string;
  relativePath: string;
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
      });
      createdFiles.push(...nestedCreatedFiles);
      continue;
    }

    if (!entry.isFile()) {
      throw new Error(`workspace bootstrap template contains unsupported entry: ${sourcePath}`);
    }

    if (await exists(targetPath)) {
      continue;
    }

    await copyFile(sourcePath, targetPath);
    const sourceMode = (await stat(sourcePath)).mode & 0o777;
    await chmod(targetPath, sourceMode);
    createdFiles.push(relativePath);
  }

  return createdFiles;
}

async function readWorkspaceTemplate(templatePath: string): Promise<string> {
  const templateContent = await readIfExists(templatePath);

  if (templateContent !== undefined) {
    return templateContent;
  }

  throw new Error(`workspace bootstrap template is missing: ${templatePath}`);
}

function workspaceTemplatePath(templateFile: string): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../defaults', templateFile);
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
