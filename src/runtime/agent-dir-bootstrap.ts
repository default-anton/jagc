import { access, mkdir } from 'node:fs/promises';

export interface AgentDirBootstrapResult {
  createdDirectory: boolean;
}

export async function bootstrapAgentDir(agentDir: string): Promise<AgentDirBootstrapResult> {
  const createdDirectory = !(await exists(agentDir));
  await mkdir(agentDir, { recursive: true, mode: 0o700 });

  return {
    createdDirectory,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
