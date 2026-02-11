import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

interface NodeEnvFileArg {
  path: string;
  optional: boolean;
}

export function parseNodeEnvFileArgs(execArgv: string[]): NodeEnvFileArg[] {
  const parsed: NodeEnvFileArg[] = [];

  for (let index = 0; index < execArgv.length; index += 1) {
    const arg = execArgv[index];
    if (!arg) {
      continue;
    }

    if (arg.startsWith('--env-file-if-exists=')) {
      parsed.push({
        path: arg.slice('--env-file-if-exists='.length),
        optional: true,
      });
      continue;
    }

    if (arg === '--env-file-if-exists') {
      const next = execArgv[index + 1];
      if (next) {
        parsed.push({ path: next, optional: true });
        index += 1;
      }
      continue;
    }

    if (arg.startsWith('--env-file=')) {
      parsed.push({
        path: arg.slice('--env-file='.length),
        optional: false,
      });
      continue;
    }

    if (arg === '--env-file') {
      const next = execArgv[index + 1];
      if (next) {
        parsed.push({ path: next, optional: false });
        index += 1;
      }
    }
  }

  return parsed;
}

export function applyNodeEnvFileOverrides(execArgv: string[] = process.execArgv): string[] {
  const envFiles = parseNodeEnvFileArgs(execArgv);
  const appliedPaths: string[] = [];

  for (const envFile of envFiles) {
    if (envFile.path.length === 0) {
      continue;
    }

    if (!existsSync(envFile.path)) {
      if (!envFile.optional) {
        throw new Error(`Node --env-file path does not exist: ${envFile.path}`);
      }
      continue;
    }

    let content: string;

    try {
      content = readFileSync(envFile.path, 'utf8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`failed reading env file ${envFile.path}: ${detail}`);
    }

    let parsed: Record<string, string | undefined>;

    try {
      parsed = parseEnv(content);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`failed parsing env file ${envFile.path}: ${detail}`);
    }

    for (const [key, value] of Object.entries(parsed)) {
      if (value === undefined) {
        continue;
      }

      process.env[key] = value;
    }

    appliedPaths.push(envFile.path);
  }

  return appliedPaths;
}
