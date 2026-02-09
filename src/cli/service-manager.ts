import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const defaultServiceLabel = 'com.jagc.server';
const defaultLaunchAgentsDir = join(homedir(), 'Library', 'LaunchAgents');

export const supportedLogLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type ServiceLogLevel = (typeof supportedLogLevels)[number];
export type ServiceRunner = 'pi' | 'echo';

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

interface LaunchAgentConfig {
  label: string;
  nodePath: string;
  serverEntrypoint: string;
  workspaceDir: string;
  databasePath: string;
  host: string;
  port: number;
  runner: ServiceRunner;
  logLevel: ServiceLogLevel;
  stdoutPath: string;
  stderrPath: string;
  telegramBotToken?: string;
}

interface LaunchctlPrintState {
  loaded: boolean;
  running: boolean;
  pid: number | null;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function createServiceManager(platform: NodeJS.Platform = process.platform): PlatformServiceManager {
  if (platform === 'darwin') {
    return new MacOsServiceManager();
  }

  return new UnsupportedServiceManager(platform);
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

export function renderLaunchAgentPlist(config: LaunchAgentConfig): string {
  const environmentVariables: Record<string, string> = {
    PATH: buildLaunchdPath(config.nodePath),
    JAGC_WORKSPACE_DIR: config.workspaceDir,
    JAGC_DATABASE_PATH: config.databasePath,
    JAGC_HOST: config.host,
    JAGC_PORT: String(config.port),
    JAGC_RUNNER: config.runner,
    JAGC_LOG_LEVEL: config.logLevel,
  };

  if (config.telegramBotToken) {
    environmentVariables.JAGC_TELEGRAM_BOT_TOKEN = config.telegramBotToken;
  }

  const envLines = Object.entries(environmentVariables)
    .map(([key, value]) => `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(config.label)}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(config.nodePath)}</string>
      <string>${xmlEscape(config.serverEntrypoint)}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${xmlEscape(config.workspaceDir)}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ProcessType</key>
    <string>Background</string>

    <key>EnvironmentVariables</key>
    <dict>
${envLines}
    </dict>

    <key>StandardOutPath</key>
    <string>${xmlEscape(config.stdoutPath)}</string>

    <key>StandardErrorPath</key>
    <string>${xmlEscape(config.stderrPath)}</string>
  </dict>
</plist>
`;
}

export function parseLaunchctlPrintOutput(output: string): LaunchctlPrintState {
  const stateMatch = output.match(/\bstate\s*=\s*(\w+)/);
  const pidMatch = output.match(/\bpid\s*=\s*(\d+)/);

  const pid = pidMatch ? Number(pidMatch[1]) : null;
  const parsedPid = Number.isFinite(pid) ? pid : null;
  const running = stateMatch?.[1] === 'running' || parsedPid !== null;

  return {
    loaded: true,
    running,
    pid: parsedPid,
  };
}

export function parseLaunchAgentServiceConnection(plist: string): { host: string | null; port: number | null } {
  const envDictMatch = plist.match(/<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/i);
  if (!envDictMatch) {
    return { host: null, port: null };
  }

  const envSection = envDictMatch[1];
  if (!envSection) {
    return { host: null, port: null };
  }

  const envPairs = new Map<string, string>();
  const pairPattern = /<key>([^<]+)<\/key>\s*<string>([\s\S]*?)<\/string>/g;

  for (const match of envSection.matchAll(pairPattern)) {
    const key = match[1];
    const value = match[2];

    if (!key || value === undefined) {
      continue;
    }

    envPairs.set(xmlUnescape(key.trim()), xmlUnescape(value.trim()));
  }

  const host = envPairs.get('JAGC_HOST') ?? null;
  const rawPort = envPairs.get('JAGC_PORT');
  const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : Number.NaN;
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : null;

  return {
    host,
    port,
  };
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

    await mkdir(launchAgentsDir, { recursive: true });
    await mkdir(options.workspaceDir, { recursive: true, mode: 0o700 });
    await mkdir(logsDir, { recursive: true, mode: 0o700 });

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
      telegramBotToken: options.telegramBotToken,
      stdoutPath,
      stderrPath,
    });

    await writeFile(plistPath, plist, { mode: 0o644 });

    await this.bootout(launchctlTarget);
    await this.waitForUnload(launchctlTarget);
    await runCommand('/bin/launchctl', ['bootstrap', launchctlTarget.split('/').slice(0, 2).join('/'), plistPath]);
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
      await runCommand('/bin/launchctl', ['bootstrap', launchctlTarget.split('/').slice(0, 2).join('/'), plistPath]);
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
    };
  }

  async restart(_options: ServiceControlOptions): Promise<ServiceStatus> {
    throw unsupportedPlatformError(this.platform);
  }

  async uninstall(_options: ServiceUninstallOptions): Promise<ServiceUninstallResult> {
    throw unsupportedPlatformError(this.platform);
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<CommandResult> {
  const result = await new Promise<CommandResult>((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      stderr += `${error.message}`;
    });

    child.on('close', (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });

  if (!options.allowFailure && result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.code}: ${result.stderr || result.stdout}`,
    );
  }

  return result;
}

async function readLaunchAgentServiceConnection(
  plistPath: string,
): Promise<{ host: string | null; port: number | null }> {
  if (!(await fileExists(plistPath))) {
    return { host: null, port: null };
  }

  try {
    const plist = await readFile(plistPath, 'utf8');
    return parseLaunchAgentServiceConnection(plist);
  } catch {
    return { host: null, port: null };
  }
}

function buildPlistPath(launchAgentsDir: string, label: string): string {
  return join(launchAgentsDir, `${label}.plist`);
}

function buildLaunchctlTarget(label: string, launchctlDomain?: string): string {
  const domain = launchctlDomain ?? resolveLaunchctlDomain();
  return `${domain}/${label}`;
}

function resolveLaunchctlDomain(): string {
  if (typeof process.getuid !== 'function') {
    throw new Error('launchctl service management requires process.getuid() on this platform');
  }

  return `gui/${process.getuid()}`;
}

function buildLaunchdPath(nodePath: string): string {
  const candidates = [dirname(nodePath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const seen = new Set<string>();

  return candidates
    .filter((entry) => {
      if (seen.has(entry)) {
        return false;
      }

      seen.add(entry);
      return true;
    })
    .join(':');
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function unsupportedPlatformError(platform: NodeJS.Platform): Error {
  return new Error(`service management is not implemented for platform '${platform}' yet`);
}

function isLaunchctlMissingServiceError(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes('could not find service') ||
    normalized.includes('no such process') ||
    normalized.includes('service already unloaded')
  );
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
