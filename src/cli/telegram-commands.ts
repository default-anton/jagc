import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Command } from 'commander';

import { exitWithError, printJson } from './common.js';
import {
  createServiceManager,
  defaultServiceLabel,
  renderDefaultUserServiceEnvironment,
  type ServiceStatus,
  serviceEnvFilename,
  upsertEnvironmentFileVariable,
} from './service-manager.js';

const defaultWorkspaceDir = process.env.JAGC_WORKSPACE_DIR ?? join(homedir(), '.jagc');
const telegramAllowedUserIdsKey = 'JAGC_TELEGRAM_ALLOWED_USER_IDS';

interface TelegramAllowCommandOptions {
  userId: string;
  workspaceDir: string;
  label: string;
  launchctlDomain?: string;
  restart: boolean;
  json?: boolean;
}

interface TelegramListCommandOptions {
  workspaceDir: string;
  json?: boolean;
}

interface TelegramCommandsDependencies {
  createServiceManagerImpl?: typeof createServiceManager;
  readFileImpl?: typeof readFile;
  writeFileImpl?: typeof writeFile;
  mkdirImpl?: typeof mkdir;
  printJsonImpl?: typeof printJson;
  writeStdoutImpl?: (line: string) => void;
}

export function registerTelegramCommands(program: Command, dependencies: TelegramCommandsDependencies = {}): void {
  const createServiceManagerImpl = dependencies.createServiceManagerImpl ?? createServiceManager;
  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const writeFileImpl = dependencies.writeFileImpl ?? writeFile;
  const mkdirImpl = dependencies.mkdirImpl ?? mkdir;
  const printJsonImpl = dependencies.printJsonImpl ?? printJson;
  const writeStdoutImpl = dependencies.writeStdoutImpl ?? ((line: string) => process.stdout.write(`${line}\n`));

  const telegramCommand = program.command('telegram').description('manage Telegram access controls');

  telegramCommand
    .command('allow')
    .description('allow a Telegram user id to chat with the bot')
    .requiredOption('--user-id <id>', 'Telegram user id')
    .option('--workspace-dir <path>', 'workspace directory', defaultWorkspaceDir)
    .option('--label <label>', 'launchd label', defaultServiceLabel)
    .option('--launchctl-domain <domain>', 'launchctl domain override (advanced)')
    .option('--no-restart', 'skip service restart after allowlist update')
    .option('--json', 'JSON output')
    .action(async (options: TelegramAllowCommandOptions) => {
      try {
        const normalizedUserId = normalizeTelegramUserId(options.userId);
        const serviceEnvPath = join(options.workspaceDir, serviceEnvFilename);

        await ensureServiceEnvFile(serviceEnvPath, {
          readFileImpl,
          writeFileImpl,
          mkdirImpl,
        });

        const currentContent = await readFileImpl(serviceEnvPath, 'utf8');
        const currentAllowedUserIds = parseAllowedTelegramUserIds(
          readEnvironmentFileVariable(currentContent, telegramAllowedUserIdsKey),
        );

        const alreadyAllowed = currentAllowedUserIds.includes(normalizedUserId);
        const nextAllowedUserIds = alreadyAllowed
          ? currentAllowedUserIds
          : [...currentAllowedUserIds, normalizedUserId];
        const updatedContent = upsertEnvironmentFileVariable(
          currentContent,
          telegramAllowedUserIdsKey,
          nextAllowedUserIds.join(','),
        );

        if (updatedContent !== currentContent) {
          await writeFileImpl(serviceEnvPath, updatedContent, 'utf8');
        }

        let restartStatus: ServiceStatus | null = null;
        if (options.restart) {
          const manager = createServiceManagerImpl();
          restartStatus = await manager.restart({
            label: options.label,
            workspaceDir: options.workspaceDir,
            launchctlDomain: options.launchctlDomain,
          });
        }

        if (options.json) {
          printJsonImpl({
            user_id: normalizedUserId,
            already_allowed: alreadyAllowed,
            allowed_user_ids: nextAllowedUserIds,
            service_env_path: serviceEnvPath,
            restarted: options.restart,
            service_status: restartStatus
              ? {
                  running: restartStatus.running,
                  pid: restartStatus.pid,
                  label: restartStatus.label,
                }
              : null,
          });
          return;
        }

        writeStdoutImpl(
          alreadyAllowed
            ? `telegram user ${normalizedUserId} is already allowed`
            : `allowed telegram user ${normalizedUserId}`,
        );
        writeStdoutImpl(`service env: ${serviceEnvPath}`);

        if (!options.restart) {
          writeStdoutImpl('restart skipped (--no-restart); run `jagc restart` to apply changes');
          return;
        }

        if (!restartStatus?.running) {
          writeStdoutImpl('service restarted but is not running; check `jagc status` and logs');
          return;
        }

        writeStdoutImpl(`service restarted (${restartStatus.label}, pid ${restartStatus.pid ?? 'unknown'})`);
      } catch (error) {
        exitWithError(error);
      }
    });

  telegramCommand
    .command('list')
    .description('list allowed Telegram user ids from service.env')
    .option('--workspace-dir <path>', 'workspace directory', defaultWorkspaceDir)
    .option('--json', 'JSON output')
    .action(async (options: TelegramListCommandOptions) => {
      try {
        const serviceEnvPath = join(options.workspaceDir, serviceEnvFilename);
        const content = await readFileIfExists(serviceEnvPath, readFileImpl);
        const allowedUserIds = parseAllowedTelegramUserIds(
          readEnvironmentFileVariable(content ?? '', telegramAllowedUserIdsKey),
        );

        if (options.json) {
          printJsonImpl({
            allowed_user_ids: allowedUserIds,
            service_env_path: serviceEnvPath,
          });
          return;
        }

        if (allowedUserIds.length === 0) {
          writeStdoutImpl(`no Telegram user ids are allowed (${serviceEnvPath})`);
          return;
        }

        writeStdoutImpl(`allowed Telegram user ids (${serviceEnvPath}): ${allowedUserIds.join(', ')}`);
      } catch (error) {
        exitWithError(error);
      }
    });
}

async function ensureServiceEnvFile(
  serviceEnvPath: string,
  options: {
    readFileImpl: typeof readFile;
    writeFileImpl: typeof writeFile;
    mkdirImpl: typeof mkdir;
  },
): Promise<void> {
  const existing = await readFileIfExists(serviceEnvPath, options.readFileImpl);
  if (existing !== null) {
    return;
  }

  await options.mkdirImpl(dirname(serviceEnvPath), { recursive: true });
  await options.writeFileImpl(serviceEnvPath, renderDefaultUserServiceEnvironment(), 'utf8');
}

async function readFileIfExists(path: string, readFileImpl: typeof readFile): Promise<string | null> {
  try {
    return await readFileImpl(path, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

function readEnvironmentFileVariable(content: string, key: string): string | undefined {
  const lines = content.replaceAll('\r\n', '\n').split('\n');

  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match || match[1] !== key) {
      continue;
    }

    return parseEnvironmentFileValue(match[2] ?? '');
  }

  return undefined;
}

function parseEnvironmentFileValue(rawValue: string): string {
  const value = rawValue.trim();
  if (value.length === 0) {
    return '';
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value) as string;
      } catch {
        return value.slice(1, -1);
      }
    }

    return value.slice(1, -1);
  }

  return value;
}

function parseAllowedTelegramUserIds(rawValue: string | undefined): string[] {
  if (!rawValue || rawValue.trim().length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const allowedUserIds: string[] = [];

  for (const entry of rawValue.split(',')) {
    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }

    if (!/^\d+$/u.test(normalized)) {
      throw new Error(
        `service.env contains invalid ${telegramAllowedUserIdsKey} entry '${normalized}'. Use comma-separated numeric ids.`,
      );
    }

    const canonicalUserId = canonicalizeTelegramUserId(normalized);

    if (seen.has(canonicalUserId)) {
      continue;
    }

    seen.add(canonicalUserId);
    allowedUserIds.push(canonicalUserId);
  }

  return allowedUserIds;
}

function normalizeTelegramUserId(rawValue: string): string {
  const value = rawValue.trim();
  if (!/^\d+$/u.test(value)) {
    throw new Error(`Telegram user id must be numeric. Received: '${rawValue}'`);
  }

  return canonicalizeTelegramUserId(value);
}

function canonicalizeTelegramUserId(value: string): string {
  return BigInt(value).toString();
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
