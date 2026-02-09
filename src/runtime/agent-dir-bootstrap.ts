import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AgentDirBootstrapResult {
  createdDirectory: boolean;
}

const workspaceGitignoreEntries = ['.sessions/', 'auth.json', 'git/'];

export async function bootstrapAgentDir(agentDir: string): Promise<AgentDirBootstrapResult> {
  const createdDirectory = !(await exists(agentDir));
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await ensureWorkspaceGitignore(agentDir);

  return {
    createdDirectory,
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
