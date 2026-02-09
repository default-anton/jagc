import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

const defaultWorkspaceDir = join(homedir(), '.jagc');

const envSchema = z.object({
  JAGC_DATABASE_PATH: z.string().trim().min(1).optional(),
  JAGC_WORKSPACE_DIR: z.string().min(1).default(defaultWorkspaceDir),
  JAGC_RUNNER: z.enum(['pi', 'echo']).default('pi'),
  JAGC_HOST: z.string().min(1).default('127.0.0.1'),
  JAGC_PORT: z.coerce.number().int().positive().default(31415),
  JAGC_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  JAGC_TELEGRAM_BOT_TOKEN: z.string().trim().min(1).optional(),
});

export interface AppConfig {
  JAGC_DATABASE_PATH: string;
  JAGC_WORKSPACE_DIR: string;
  JAGC_RUNNER: 'pi' | 'echo';
  JAGC_HOST: string;
  JAGC_PORT: number;
  JAGC_LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  JAGC_TELEGRAM_BOT_TOKEN?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = envSchema.parse(env);
  const workspaceDir = expandHomePath(config.JAGC_WORKSPACE_DIR);
  const databasePath = resolveDatabasePath(workspaceDir, config.JAGC_DATABASE_PATH);

  return {
    ...config,
    JAGC_WORKSPACE_DIR: workspaceDir,
    JAGC_DATABASE_PATH: databasePath,
  };
}

function resolveDatabasePath(workspaceDir: string, configuredPath?: string): string {
  const candidatePath = configuredPath ? expandHomePath(configuredPath) : join(workspaceDir, 'jagc.sqlite');

  if (isAbsolute(candidatePath)) {
    return candidatePath;
  }

  return resolve(workspaceDir, candidatePath);
}

function expandHomePath(path: string): string {
  if (path === '~') {
    return homedir();
  }

  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }

  return path;
}
