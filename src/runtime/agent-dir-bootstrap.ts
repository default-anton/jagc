import { access, chmod, copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const defaultLegacyPiAgentDir = join(homedir(), '.pi/agent');

export interface AgentDirBootstrapResult {
  copiedSettings: boolean;
  copiedAuth: boolean;
}

interface BootstrapOptions {
  legacyAgentDir?: string;
}

export async function bootstrapAgentDir(
  agentDir: string,
  options: BootstrapOptions = {},
): Promise<AgentDirBootstrapResult> {
  const legacyPiAgentDir = options.legacyAgentDir ?? defaultLegacyPiAgentDir;

  await mkdir(agentDir, { recursive: true, mode: 0o700 });

  if (isSamePath(agentDir, legacyPiAgentDir)) {
    return {
      copiedSettings: false,
      copiedAuth: false,
    };
  }

  const copiedSettings = await copyIfMissing(join(legacyPiAgentDir, 'settings.json'), join(agentDir, 'settings.json'));

  const copiedAuth = await copyIfMissing(join(legacyPiAgentDir, 'auth.json'), join(agentDir, 'auth.json'));

  if (copiedAuth) {
    await chmod(join(agentDir, 'auth.json'), 0o600);
  }

  return {
    copiedSettings,
    copiedAuth,
  };
}

function isSamePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

async function copyIfMissing(source: string, destination: string): Promise<boolean> {
  if (await exists(destination)) {
    return false;
  }

  if (!(await exists(source))) {
    return false;
  }

  await copyFile(source, destination);
  return true;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
