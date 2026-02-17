import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runCommand } from './service-manager-command.js';
import {
  applyServiceInstallEnvironmentOverrides,
  buildServiceEnvironmentSnapshot,
  ensureServiceEnvironmentFiles,
  nodeEnvFileIfExistsVersionRequirement,
  renderDefaultUserServiceEnvironment,
  serviceEnvFilename,
  serviceEnvSnapshotFilename,
  upsertEnvironmentFileVariable,
} from './service-manager-environment.js';
import {
  buildLaunchctlTarget,
  buildPlistPath,
  isLaunchctlMissingServiceError,
  parseLaunchAgentServiceConnection,
  parseLaunchctlPrintOutput,
  readLaunchAgentServiceConnection,
  renderLaunchAgentPlist,
  resolveLaunchctlBootstrapDomain,
} from './service-manager-launchd.js';
import { type ServiceLogLevel, type ServiceRunner, supportedLogLevels } from './service-manager-types.js';

export const defaultServiceLabel = 'com.jagc.server';
const defaultLaunchAgentsDir = join(homedir(), 'Library', 'LaunchAgents');

export { supportedLogLevels };
export type { ServiceLogLevel, ServiceRunner };

export interface ServiceInstallOptions {
  label: string;
  workspaceDir: string;
  databasePath: string;
  host: string;
  port: number;
  runner: ServiceRunner;
  logLevel: ServiceLogLevel;
  telegramBotToken?: string;
  launchAgentsDir?: string;
  launchctlDomain?: string;
}

export interface ServiceControlOptions {
  label: string;
  workspaceDir?: string;
  launchAgentsDir?: string;
  launchctlDomain?: string;
}

export interface ServiceUninstallOptions extends ServiceControlOptions {
  workspaceDir: string;
  purgeData: boolean;
}

export interface ServiceStatus {
  platform: NodeJS.Platform;
  supported: boolean;
  label: string;
  plistPath: string;
  launchctlTarget: string;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  pid: number | null;
  apiHost: string | null;
  apiPort: number | null;
  stdoutPath: string;
  stderrPath: string;
  serviceEnvPath: string;
  serviceEnvSnapshotPath: string;
}

export interface ServiceInstallResult {
  status: ServiceStatus;
}

export interface ServiceUninstallResult {
  status: ServiceStatus;
  removedPlist: boolean;
  removedWorkspace: boolean;
}

export interface PlatformServiceManager {
  readonly platform: NodeJS.Platform;
  install(options: ServiceInstallOptions): Promise<ServiceInstallResult>;
  status(options: ServiceControlOptions): Promise<ServiceStatus>;
  restart(options: ServiceControlOptions): Promise<ServiceStatus>;
  uninstall(options: ServiceUninstallOptions): Promise<ServiceUninstallResult>;
}

export {
  applyServiceInstallEnvironmentOverrides,
  buildServiceEnvironmentSnapshot,
  nodeEnvFileIfExistsVersionRequirement,
  parseLaunchAgentServiceConnection,
  parseLaunchctlPrintOutput,
  renderDefaultUserServiceEnvironment,
  renderLaunchAgentPlist,
  serviceEnvFilename,
  serviceEnvSnapshotFilename,
  upsertEnvironmentFileVariable,
};

export function createServiceManager(platform: NodeJS.Platform = process.platform): PlatformServiceManager {
  if (platform === 'darwin') {
    return new MacOsServiceManager();
  }

  return new UnsupportedServiceManager(platform);
}

export function supportsNodeEnvFileIfExists(nodeVersion: string): boolean {
  const parsedVersion = parseNodeVersion(nodeVersion);
  if (!parsedVersion) {
    return false;
  }

  const { major, minor } = parsedVersion;
  if (major < 20) {
    return false;
  }

  if (major === 20) {
    return minor >= 19;
  }

  if (major === 21) {
    return false;
  }

  if (major === 22) {
    return minor >= 9;
  }

  return major >= 23;
}

export async function resolveServerEntrypoint(cliEntrypointPath: string): Promise<string> {
  const cliDirectory = dirname(cliEntrypointPath);
  const candidates = [resolve(cliDirectory, '../server/main.mjs'), resolve(cliDirectory, '../../dist/server/main.mjs')];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `unable to locate built server entrypoint (.mjs) near CLI at ${cliEntrypointPath}; run 'pnpm build' and retry`,
  );
}

class MacOsServiceManager implements PlatformServiceManager {
  readonly platform = 'darwin' as const;

  async install(options: ServiceInstallOptions): Promise<ServiceInstallResult> {
    const launchAgentsDir = options.launchAgentsDir ?? defaultLaunchAgentsDir;
    const launchctlTarget = buildLaunchctlTarget(options.label, options.launchctlDomain);
    const plistPath = buildPlistPath(launchAgentsDir, options.label);
    const logsDir = join(options.workspaceDir, 'logs');
    const stdoutPath = join(logsDir, 'server.out.log');
    const stderrPath = join(logsDir, 'server.err.log');
    const serviceEnvPath = join(options.workspaceDir, serviceEnvFilename);
    const serviceEnvSnapshotPath = join(options.workspaceDir, serviceEnvSnapshotFilename);

    await mkdir(launchAgentsDir, { recursive: true });
    await mkdir(options.workspaceDir, { recursive: true, mode: 0o700 });
    await mkdir(logsDir, { recursive: true, mode: 0o700 });

    await ensureServiceEnvironmentFiles({
      serviceEnvPath,
      serviceEnvSnapshotPath,
      nodePath: process.execPath,
      telegramBotToken: options.telegramBotToken,
    });

    const serverEntrypoint = await resolveServerEntrypoint(fileURLToPath(import.meta.url));
    const plist = renderLaunchAgentPlist({
      label: options.label,
      nodePath: process.execPath,
      serverEntrypoint,
      workspaceDir: options.workspaceDir,
      databasePath: options.databasePath,
      host: options.host,
      port: options.port,
      runner: options.runner,
      logLevel: options.logLevel,
      stdoutPath,
      stderrPath,
      serviceEnvPath,
      serviceEnvSnapshotPath,
    });

    await writeFile(plistPath, plist, { mode: 0o644 });

    await this.bootout(launchctlTarget);
    await this.waitForUnload(launchctlTarget);
    await runCommand('/bin/launchctl', ['bootstrap', resolveLaunchctlBootstrapDomain(launchctlTarget), plistPath]);
    await runCommand('/bin/launchctl', ['kickstart', '-k', launchctlTarget]);

    return {
      status: await this.status({
        label: options.label,
        workspaceDir: options.workspaceDir,
        launchAgentsDir,
        launchctlDomain: options.launchctlDomain,
      }),
    };
  }

  async status(options: ServiceControlOptions): Promise<ServiceStatus> {
    const launchAgentsDir = options.launchAgentsDir ?? defaultLaunchAgentsDir;
    const launchctlTarget = buildLaunchctlTarget(options.label, options.launchctlDomain);
    const plistPath = buildPlistPath(launchAgentsDir, options.label);
    const installed = await fileExists(plistPath);

    const printResult = await runCommand('/bin/launchctl', ['print', launchctlTarget], {
      allowFailure: true,
    });

    const missingService = isLaunchctlMissingServiceError(`${printResult.stderr}\n${printResult.stdout}`);
    const loaded = printResult.code === 0 && !missingService;
    const parsed = loaded
      ? parseLaunchctlPrintOutput(printResult.stdout)
      : { loaded: false, running: false, pid: null };
    const serviceConnection = await readLaunchAgentServiceConnection(plistPath);

    return {
      platform: this.platform,
      supported: true,
      label: options.label,
      plistPath,
      launchctlTarget,
      installed,
      loaded,
      running: parsed.running,
      pid: parsed.pid,
      apiHost: serviceConnection.host,
      apiPort: serviceConnection.port,
      stdoutPath: join(options.workspaceDir ?? defaultWorkspaceDir(), 'logs', 'server.out.log'),
      stderrPath: join(options.workspaceDir ?? defaultWorkspaceDir(), 'logs', 'server.err.log'),
      serviceEnvPath: join(options.workspaceDir ?? defaultWorkspaceDir(), serviceEnvFilename),
      serviceEnvSnapshotPath: join(options.workspaceDir ?? defaultWorkspaceDir(), serviceEnvSnapshotFilename),
    };
  }

  async restart(options: ServiceControlOptions): Promise<ServiceStatus> {
    const launchAgentsDir = options.launchAgentsDir ?? defaultLaunchAgentsDir;
    const launchctlTarget = buildLaunchctlTarget(options.label, options.launchctlDomain);
    const plistPath = buildPlistPath(launchAgentsDir, options.label);

    if (!(await fileExists(plistPath))) {
      throw new Error(`service plist not found at ${plistPath}; run 'jagc install' first`);
    }

    const printResult = await runCommand('/bin/launchctl', ['print', launchctlTarget], {
      allowFailure: true,
    });

    if (printResult.code !== 0) {
      await runCommand('/bin/launchctl', ['bootstrap', resolveLaunchctlBootstrapDomain(launchctlTarget), plistPath]);
    }

    await runCommand('/bin/launchctl', ['kickstart', '-k', launchctlTarget]);
    return this.status({
      label: options.label,
      workspaceDir: options.workspaceDir,
      launchAgentsDir,
      launchctlDomain: options.launchctlDomain,
    });
  }

  async uninstall(options: ServiceUninstallOptions): Promise<ServiceUninstallResult> {
    const launchAgentsDir = options.launchAgentsDir ?? defaultLaunchAgentsDir;
    const launchctlTarget = buildLaunchctlTarget(options.label, options.launchctlDomain);
    const plistPath = buildPlistPath(launchAgentsDir, options.label);

    await this.bootout(launchctlTarget);
    await this.waitForUnload(launchctlTarget);

    const hadPlist = await fileExists(plistPath);
    if (hadPlist) {
      await rm(plistPath, { force: true });
    }

    let removedWorkspace = false;
    if (options.purgeData) {
      await rm(options.workspaceDir, { recursive: true, force: true });
      removedWorkspace = true;
    }

    return {
      status: await this.status({
        label: options.label,
        workspaceDir: options.workspaceDir,
        launchAgentsDir,
        launchctlDomain: options.launchctlDomain,
      }),
      removedPlist: hadPlist,
      removedWorkspace,
    };
  }

  private async bootout(launchctlTarget: string): Promise<void> {
    const result = await runCommand('/bin/launchctl', ['bootout', launchctlTarget], {
      allowFailure: true,
    });

    if (result.code === 0 || isLaunchctlMissingServiceError(`${result.stderr}\n${result.stdout}`)) {
      return;
    }

    throw new Error(`launchctl bootout failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }

  private async waitForUnload(launchctlTarget: string): Promise<void> {
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      const printResult = await runCommand('/bin/launchctl', ['print', launchctlTarget], {
        allowFailure: true,
      });

      if (printResult.code !== 0 || isLaunchctlMissingServiceError(`${printResult.stderr}\n${printResult.stdout}`)) {
        return;
      }

      await sleep(200);
    }
  }
}

class UnsupportedServiceManager implements PlatformServiceManager {
  constructor(readonly platform: NodeJS.Platform) {}

  async install(_options: ServiceInstallOptions): Promise<ServiceInstallResult> {
    throw unsupportedPlatformError(this.platform);
  }

  async status(options: ServiceControlOptions): Promise<ServiceStatus> {
    return {
      platform: this.platform,
      supported: false,
      label: options.label,
      plistPath: '',
      launchctlTarget: '',
      installed: false,
      loaded: false,
      running: false,
      pid: null,
      apiHost: null,
      apiPort: null,
      stdoutPath: '',
      stderrPath: '',
      serviceEnvPath: '',
      serviceEnvSnapshotPath: '',
    };
  }

  async restart(_options: ServiceControlOptions): Promise<ServiceStatus> {
    throw unsupportedPlatformError(this.platform);
  }

  async uninstall(_options: ServiceUninstallOptions): Promise<ServiceUninstallResult> {
    throw unsupportedPlatformError(this.platform);
  }
}

function parseNodeVersion(nodeVersion: string): { major: number; minor: number; patch: number } | null {
  const normalized = nodeVersion.trim().replace(/^v/i, '');
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }

  const major = Number.parseInt(match[1] ?? '', 10);
  const minor = Number.parseInt(match[2] ?? '', 10);
  const patch = Number.parseInt(match[3] ?? '', 10);

  if (![major, minor, patch].every((value) => Number.isInteger(value) && value >= 0)) {
    return null;
  }

  return { major, minor, patch };
}

function unsupportedPlatformError(platform: NodeJS.Platform): Error {
  return new Error(`service management is not implemented for platform '${platform}' yet`);
}

function defaultWorkspaceDir(): string {
  return process.env.JAGC_WORKSPACE_DIR ?? join(homedir(), '.jagc');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
