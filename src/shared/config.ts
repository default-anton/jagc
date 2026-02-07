import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

const defaultWorkspaceDir = join(homedir(), '.jagc');

const envSchema = z.object({
  JAGC_DATABASE_URL: z.string().min(1),
  JAGC_WORKSPACE_DIR: z.string().min(1).default(defaultWorkspaceDir),
  JAGC_RUNNER: z.enum(['pi', 'echo']).default('pi'),
  JAGC_HOST: z.string().min(1).default('127.0.0.1'),
  JAGC_PORT: z.coerce.number().int().positive().default(31415),
  JAGC_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  JAGC_TELEGRAM_BOT_TOKEN: z.string().trim().min(1).optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = envSchema.parse(env);

  return {
    ...config,
    JAGC_WORKSPACE_DIR: expandHomePath(config.JAGC_WORKSPACE_DIR),
  };
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
