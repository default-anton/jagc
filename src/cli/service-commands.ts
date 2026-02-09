import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { type Command, Option } from 'commander';
import { healthcheck } from './client.js';
import { exitWithError, parsePositiveNumber, printJson } from './common.js';
import {
  createServiceManager,
  defaultServiceLabel,
  resolveServerEntrypoint,
  type ServiceLogLevel,
  type ServiceRunner,
  type ServiceStatus,
  supportedLogLevels,
} from './service-manager.js';

const defaultWorkspaceDir = process.env.JAGC_WORKSPACE_DIR ?? join(homedir(), '.jagc');
const defaultDatabasePath = process.env.JAGC_DATABASE_PATH;
const defaultHost = process.env.JAGC_HOST ?? '127.0.0.1';
const defaultPort = parsePositiveNumberFromEnv(process.env.JAGC_PORT, 31415);
const defaultRunner: ServiceRunner = process.env.JAGC_RUNNER === 'echo' ? 'echo' : 'pi';
const defaultLogLevel: ServiceLogLevel = isServiceLogLevel(process.env.JAGC_LOG_LEVEL)
  ? process.env.JAGC_LOG_LEVEL
  : 'info';

interface InstallCommandOptions {
  label: string;
  workspaceDir: string;
  databasePath?: string;
  host: string;
  port: number;
  runner: ServiceRunner;
  logLevel: ServiceLogLevel;
  telegramBotToken?: string;
  waitSeconds: number;
  json?: boolean;
}

interface StatusCommandOptions {
  label: string;
  workspaceDir: string;
  json?: boolean;
}

interface RestartCommandOptions {
  label: string;
  workspaceDir: string;
  waitSeconds: number;
  json?: boolean;
}

interface UninstallCommandOptions {
  label: string;
  workspaceDir: string;
  purgeData?: boolean;
  force?: boolean;
  json?: boolean;
}

interface DoctorCommandOptions {
  label: string;
  workspaceDir: string;
  json?: boolean;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function registerServiceCommands(program: Command): void {
  program
    .command('install')
    .description('install and start jagc as a background service for this user')
    .option('--label <label>', 'launchd label', defaultServiceLabel)
    .option('--workspace-dir <path>', 'workspace directory', defaultWorkspaceDir)
    .option(
      '--database-path <path>',
      `SQLite database path (default: <workspace-dir>/jagc.sqlite${defaultDatabasePath ? `; env JAGC_DATABASE_PATH=${defaultDatabasePath}` : ''})`,
    )
    .option('--host <host>', 'server bind host', defaultHost)
    .option('--port <port>', 'server bind port', parsePositiveNumber, defaultPort)
    .addOption(new Option('--runner <runner>', 'runtime runner').choices(['pi', 'echo']).default(defaultRunner))
    .addOption(
      new Option('--log-level <level>', 'server log level').choices(supportedLogLevels).default(defaultLogLevel),
    )
    .option('--telegram-bot-token <token>', 'telegram bot token')
    .option('--wait-seconds <seconds>', 'seconds to wait for /healthz after start', parsePositiveNumber, 20)
    .option('--json', 'JSON output')
    .action(
      withCliErrorHandling(async (options: InstallCommandOptions) => {
        const manager = createServiceManager();
        const databasePath = options.databasePath ?? defaultDatabasePath ?? join(options.workspaceDir, 'jagc.sqlite');
        const installResult = await manager.install({
          label: options.label,
          workspaceDir: options.workspaceDir,
          databasePath,
          host: options.host,
          port: options.port,
          runner: options.runner,
          logLevel: options.logLevel,
          telegramBotToken: options.telegramBotToken,
        });

        const apiUrl = `http://${options.host}:${options.port}`;
        const health = await waitForHealth(apiUrl, options.waitSeconds * 1000);

        if (!health.ok) {
          throw new Error(
            `service started but health check failed at ${apiUrl}/healthz after ${options.waitSeconds}s; check logs: ${installResult.status.stderrPath}`,
          );
        }

        if (options.json) {
          printJson({
            service: installResult.status,
            api_url: apiUrl,
            health,
          });
          return;
        }

        process.stdout.write(`installed ${options.label}\n`);
        process.stdout.write(`service: ${renderServiceState(installResult.status)}\n`);
        process.stdout.write(`api: ${apiUrl}\n`);
        process.stdout.write(`logs: ${installResult.status.stdoutPath} | ${installResult.status.stderrPath}\n`);
      }),
    );

  program
    .command('status')
    .description('show background service status')
    .option('--label <label>', 'launchd label', defaultServiceLabel)
    .option('--workspace-dir <path>', 'workspace directory', defaultWorkspaceDir)
    .option('--json', 'JSON output')
    .action(
      withCliErrorHandling(async (options: StatusCommandOptions) => {
        const manager = createServiceManager();
        const status = await manager.status({
          label: options.label,
          workspaceDir: options.workspaceDir,
        });

        if (!status.supported) {
          throw new Error(`service management is not implemented on ${process.platform} yet`);
        }

        const fallbackApiUrl = apiUrlFromProgram(program);
        const apiUrl = resolveServiceApiUrl(status, fallbackApiUrl);
        const health = await healthcheckResult(apiUrl);

        if (options.json) {
          printJson({
            service: status,
            api_url: apiUrl,
            health,
          });
          return;
        }

        process.stdout.write(`${renderServiceState(status)}\n`);
        process.stdout.write(`api: ${apiUrl} (${health.ok ? 'healthy' : `unreachable: ${health.error}`})\n`);
        process.stdout.write(`logs: ${status.stdoutPath} | ${status.stderrPath}\n`);
      }),
    );

  program
    .command('restart')
    .description('restart the background service')
    .option('--label <label>', 'launchd label', defaultServiceLabel)
    .option('--workspace-dir <path>', 'workspace directory', defaultWorkspaceDir)
    .option('--wait-seconds <seconds>', 'seconds to wait for /healthz after restart', parsePositiveNumber, 20)
    .option('--json', 'JSON output')
    .action(
      withCliErrorHandling(async (options: RestartCommandOptions) => {
        const manager = createServiceManager();
        const status = await manager.restart({
          label: options.label,
          workspaceDir: options.workspaceDir,
        });

        const fallbackApiUrl = apiUrlFromProgram(program);
        const apiUrl = resolveServiceApiUrl(status, fallbackApiUrl);
        const health = await waitForHealth(apiUrl, options.waitSeconds * 1000);

        if (!health.ok) {
          throw new Error(
            `service restarted but health check failed at ${apiUrl}/healthz after ${options.waitSeconds}s; check logs: ${status.stderrPath}`,
          );
        }

        if (options.json) {
          printJson({
            service: status,
            api_url: apiUrl,
            health,
          });
          return;
        }

        process.stdout.write(`restarted ${options.label}\n`);
        process.stdout.write(`${renderServiceState(status)}\n`);
        process.stdout.write(`api: ${apiUrl}\n`);
      }),
    );

  program
    .command('uninstall')
    .description('uninstall the background service for this user')
    .option('--label <label>', 'launchd label', defaultServiceLabel)
    .option('--workspace-dir <path>', 'workspace directory', defaultWorkspaceDir)
    .option('--purge-data', 'delete workspace data after uninstall')
    .option('--force', 'skip confirmation when --purge-data is set')
    .option('--json', 'JSON output')
    .action(
      withCliErrorHandling(async (options: UninstallCommandOptions) => {
        if (options.purgeData) {
          await confirmPurge(options.workspaceDir, Boolean(options.force));
        }

        const manager = createServiceManager();
        const result = await manager.uninstall({
          label: options.label,
          workspaceDir: options.workspaceDir,
          purgeData: Boolean(options.purgeData),
        });

        if (options.json) {
          printJson(result);
          return;
        }

        process.stdout.write(`uninstalled ${options.label}\n`);
        process.stdout.write(`plist removed: ${result.removedPlist ? 'yes' : 'no'}\n`);
        process.stdout.write(`workspace removed: ${result.removedWorkspace ? 'yes' : 'no'}\n`);
      }),
    );

  program
    .command('doctor')
    .description('diagnose local install and service health')
    .option('--label <label>', 'launchd label', defaultServiceLabel)
    .option('--workspace-dir <path>', 'workspace directory', defaultWorkspaceDir)
    .option('--json', 'JSON output')
    .action(
      withCliErrorHandling(async (options: DoctorCommandOptions) => {
        const manager = createServiceManager();
        const checks: DoctorCheck[] = [];

        const nodeMajor = Number(process.versions.node.split('.')[0]);
        checks.push({
          name: 'node_version',
          ok: Number.isFinite(nodeMajor) && nodeMajor >= 20,
          detail: `node ${process.version}`,
        });

        checks.push({
          name: 'platform',
          ok: process.platform === 'darwin',
          detail: process.platform,
        });

        try {
          const serverEntrypoint = await resolveServerEntrypoint(fileURLToPath(import.meta.url));
          checks.push({
            name: 'server_entrypoint',
            ok: true,
            detail: serverEntrypoint,
          });
        } catch (error) {
          checks.push({
            name: 'server_entrypoint',
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        }

        const serviceStatus = await manager.status({
          label: options.label,
          workspaceDir: options.workspaceDir,
        });

        checks.push({
          name: 'service_installed',
          ok: serviceStatus.installed,
          detail: serviceStatus.plistPath,
        });

        checks.push({
          name: 'service_loaded',
          ok: serviceStatus.loaded,
          detail: serviceStatus.launchctlTarget,
        });

        checks.push({
          name: 'service_running',
          ok: serviceStatus.running,
          detail: serviceStatus.pid ? `pid ${serviceStatus.pid}` : 'not running',
        });

        const fallbackApiUrl = apiUrlFromProgram(program);
        const apiUrl = resolveServiceApiUrl(serviceStatus, fallbackApiUrl);
        const health = await healthcheckResult(apiUrl);
        checks.push({
          name: 'api_health',
          ok: health.ok,
          detail: health.ok ? `${apiUrl}/healthz` : health.error,
        });

        const ok = checks.every((check) => check.ok);

        if (options.json) {
          printJson({
            ok,
            checks,
            service: serviceStatus,
            api_url: apiUrl,
            health,
          });
        } else {
          for (const check of checks) {
            process.stdout.write(`${check.ok ? 'ok' : 'fail'} ${check.name}: ${check.detail}\n`);
          }
        }

        if (!ok) {
          process.exitCode = 1;
        }
      }),
    );
}

async function confirmPurge(workspaceDir: string, force: boolean): Promise<void> {
  if (force) {
    return;
  }

  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(`refusing to purge ${workspaceDir} without --force in non-interactive mode`);
  }

  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    const response = await prompt.question(`Type PURGE to delete ${workspaceDir}: `);
    if (response.trim() !== 'PURGE') {
      throw new Error('purge cancelled');
    }
  } finally {
    prompt.close();
  }
}

function apiUrlFromProgram(program: Command): string {
  return program.opts<{ apiUrl: string }>().apiUrl;
}

function resolveServiceApiUrl(status: ServiceStatus, fallbackApiUrl: string): string {
  if (status.apiHost && status.apiPort) {
    return `http://${status.apiHost}:${status.apiPort}`;
  }

  return fallbackApiUrl;
}

function withCliErrorHandling<TOptions>(
  handler: (options: TOptions) => Promise<void>,
): (options: TOptions) => Promise<void> {
  return async (options: TOptions) => {
    try {
      await handler(options);
    } catch (error) {
      exitWithError(error);
    }
  };
}

async function healthcheckResult(apiUrl: string): Promise<{ ok: boolean; error: string }> {
  try {
    await healthcheck(apiUrl);
    return { ok: true, error: '' };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function waitForHealth(apiUrl: string, timeoutMs: number): Promise<{ ok: boolean; error: string }> {
  const startedAt = Date.now();
  let lastError = 'unknown health check failure';

  while (Date.now() - startedAt <= timeoutMs) {
    const result = await healthcheckResult(apiUrl);
    if (result.ok) {
      return result;
    }

    lastError = result.error;
    await sleep(500);
  }

  return {
    ok: false,
    error: lastError,
  };
}

function renderServiceState(status: ServiceStatus): string {
  const pid = status.pid ? ` pid=${status.pid}` : '';
  const state = status.running ? 'running' : status.loaded ? 'loaded' : 'stopped';
  return `service ${status.label} ${state}${pid} installed=${status.installed ? 'yes' : 'no'}`;
}

function parsePositiveNumberFromEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function isServiceLogLevel(value: string | undefined): value is ServiceLogLevel {
  return supportedLogLevels.includes(value as ServiceLogLevel);
}
