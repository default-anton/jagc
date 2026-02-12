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
  JAGC_TELEGRAM_ALLOWED_USER_IDS: z.string().trim().optional(),
});

export interface AppConfig {
  JAGC_DATABASE_PATH: string;
  JAGC_WORKSPACE_DIR: string;
  JAGC_RUNNER: 'pi' | 'echo';
  JAGC_HOST: string;
  JAGC_PORT: number;
  JAGC_LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  JAGC_TELEGRAM_BOT_TOKEN?: string;
  JAGC_TELEGRAM_ALLOWED_USER_IDS: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = envSchema.parse(env);
  const workspaceDir = expandHomePath(config.JAGC_WORKSPACE_DIR);
  const databasePath = resolveDatabasePath(workspaceDir, config.JAGC_DATABASE_PATH);
  const allowedTelegramUserIds = parseTelegramAllowedUserIds(config.JAGC_TELEGRAM_ALLOWED_USER_IDS);

  return {
    ...config,
    JAGC_WORKSPACE_DIR: workspaceDir,
    JAGC_DATABASE_PATH: databasePath,
    JAGC_TELEGRAM_ALLOWED_USER_IDS: allowedTelegramUserIds,
  };
}

function parseTelegramAllowedUserIds(rawValue: string | undefined): string[] {
  if (!rawValue || rawValue.trim().length === 0) {
    return [];
  }

  const values = rawValue
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const allowedUserIds: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (!/^\d+$/u.test(value)) {
      throw new Error(
        `JAGC_TELEGRAM_ALLOWED_USER_IDS contains invalid Telegram user id '${value}'. Use comma-separated numeric ids.`,
      );
    }

    const normalized = normalizeTelegramUserId(value);

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    allowedUserIds.push(normalized);
  }

  return allowedUserIds;
}

function normalizeTelegramUserId(value: string): string {
  return BigInt(value).toString();
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
