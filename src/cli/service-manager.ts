import { spawn } from 'node:child_process';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const defaultServiceLabel = 'com.jagc.server';
export const serviceEnvFilename = 'service.env';
export const serviceEnvSnapshotFilename = 'service.env.snapshot';
const defaultLaunchAgentsDir = join(homedir(), 'Library', 'LaunchAgents');

export const supportedLogLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export const nodeEnvFileIfExistsVersionRequirement = '>=20.19.0 <21 || >=22.9.0';

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
  serviceEnvPath: string;
  serviceEnvSnapshotPath: string;
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

const serviceEnvironmentExplicitKeys = new Set([
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TMPDIR',
  'HOMEBREW_PREFIX',
  'HOMEBREW_CELLAR',
  'HOMEBREW_REPOSITORY',
  'ASDF_DIR',
  'ASDF_DATA_DIR',
  'MISE_DATA_DIR',
  'MISE_CONFIG_DIR',
  'MISE_CACHE_DIR',
  'MISE_INSTALL_PATH',
  'UV_CACHE_DIR',
  'UV_TOOL_BIN_DIR',
  'UV_PYTHON_INSTALL_DIR',
  'PNPM_HOME',
  'NVM_DIR',
  'VOLTA_HOME',
  'PYENV_ROOT',
  'RBENV_ROOT',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'GOPATH',
  'GOROOT',
  'JAVA_HOME',
  'PIPX_HOME',
  'PIPX_BIN_DIR',
  'POETRY_HOME',
  'FNM_DIR',
]);

const serviceEnvironmentPrefixes = [
  'LC_',
  'HOMEBREW_',
  'MISE_',
  'ASDF_',
  'UV_',
  'PNPM_',
  'NPM_CONFIG_',
  'NVM_',
  'VOLTA_',
  'PYENV_',
  'RBENV_',
  'CARGO_',
  'RUSTUP_',
  'GOENV_',
  'PIPX_',
  'POETRY_',
  'FNM_',
];
const shellEnvironmentCaptureTimeoutMs = 5000;

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

export function renderLaunchAgentPlist(config: LaunchAgentConfig): string {
  const environmentVariables: Record<string, string> = {
    JAGC_WORKSPACE_DIR: config.workspaceDir,
    JAGC_DATABASE_PATH: config.databasePath,
    JAGC_HOST: config.host,
    JAGC_PORT: String(config.port),
    JAGC_RUNNER: config.runner,
    JAGC_LOG_LEVEL: config.logLevel,
  };

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
      <string>${xmlEscape(`--env-file-if-exists=${config.serviceEnvSnapshotPath}`)}</string>
      <string>${xmlEscape(`--env-file-if-exists=${config.serviceEnvPath}`)}</string>
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

async function runCommand(
  command: string,
  args: string[],
  options: {
    allowFailure?: boolean;
    env?: NodeJS.ProcessEnv;
    trimOutput?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  const trimOutput = options.trimOutput ?? true;
  const result = await new Promise<CommandResult>((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeoutHandle =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stderr += `${stderr ? '\n' : ''}command timed out after ${options.timeoutMs}ms`;
            child.kill('SIGKILL');
          }, options.timeoutMs)
        : null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      stderr += `${stderr ? '\n' : ''}${error.message}`;
    });

    child.on('close', (code) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      resolvePromise({
        code: timedOut ? 124 : (code ?? 1),
        stdout: trimOutput ? stdout.trim() : stdout,
        stderr: trimOutput ? stderr.trim() : stderr,
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

async function ensureServiceEnvironmentFiles(options: {
  serviceEnvPath: string;
  serviceEnvSnapshotPath: string;
  nodePath: string;
  telegramBotToken?: string;
}): Promise<void> {
  const shellPath = resolveUserShellPath();
  const shellEnvironment = (await captureShellEnvironment(shellPath)) ?? process.env;
  const snapshotEnvironment = buildServiceEnvironmentSnapshot(shellEnvironment, options.nodePath);

  const snapshotContent = renderEnvironmentFile({
    header: [
      '# jagc managed file',
      '# Regenerated by: jagc install',
      '# Captured from your login shell for package-manager/tooling PATH parity.',
      '# Edit service.env for custom overrides; this file may be replaced.',
    ],
    variables: snapshotEnvironment,
  });

  await writeFile(options.serviceEnvSnapshotPath, snapshotContent, { mode: 0o600 });
  await chmod(options.serviceEnvSnapshotPath, 0o600);

  if (!(await fileExists(options.serviceEnvPath))) {
    await writeFile(options.serviceEnvPath, renderDefaultUserServiceEnvironment(), { mode: 0o600 });
  }

  const serviceEnvContent = await readFile(options.serviceEnvPath, 'utf8');
  const updatedServiceEnvContent = applyServiceInstallEnvironmentOverrides(serviceEnvContent, {
    telegramBotToken: options.telegramBotToken,
  });

  if (updatedServiceEnvContent !== serviceEnvContent) {
    await writeFile(options.serviceEnvPath, updatedServiceEnvContent, { mode: 0o600 });
  }

  await chmod(options.serviceEnvPath, 0o600);
}

export function buildServiceEnvironmentSnapshot(shellEnv: NodeJS.ProcessEnv, nodePath: string): Record<string, string> {
  const snapshot: Record<string, string> = {};

  const shellPath = shellEnv.PATH;
  snapshot.PATH = mergePath(shellPath, nodePath);

  for (const [key, value] of Object.entries(shellEnv)) {
    if (!value) {
      continue;
    }

    if (!shouldCaptureServiceEnvironmentKey(key)) {
      continue;
    }

    snapshot[key] = value;
  }

  return sortEnvironmentEntries(snapshot);
}

function mergePath(shellPath: string | undefined, nodePath: string): string {
  const entries = [
    dirname(nodePath),
    ...(shellPath ? shellPath.split(delimiter) : []),
    ...buildLaunchdPath(nodePath).split(delimiter),
  ];

  const seen = new Set<string>();

  return entries
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (entry.length === 0 || seen.has(entry)) {
        return false;
      }

      seen.add(entry);
      return true;
    })
    .join(delimiter);
}

function sortEnvironmentEntries(entries: Record<string, string>): Record<string, string> {
  const sorted = Object.entries(entries).sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(sorted);
}

function shouldCaptureServiceEnvironmentKey(key: string): boolean {
  if (serviceEnvironmentExplicitKeys.has(key)) {
    return true;
  }

  return serviceEnvironmentPrefixes.some((prefix) => key.startsWith(prefix));
}

function renderEnvironmentFile(options: { header: string[]; variables: Record<string, string> }): string {
  const lines = [...options.header, ''];

  for (const [key, value] of Object.entries(options.variables)) {
    lines.push(`${key}=${formatEnvFileValue(value)}`);
  }

  return `${lines.join('\n')}\n`;
}

export function applyServiceInstallEnvironmentOverrides(
  content: string,
  options: { telegramBotToken?: string },
): string {
  let updatedContent = content;

  if (options.telegramBotToken) {
    updatedContent = upsertEnvironmentFileVariable(updatedContent, 'JAGC_TELEGRAM_BOT_TOKEN', options.telegramBotToken);
  }

  return updatedContent;
}

export function upsertEnvironmentFileVariable(content: string, key: string, value: string): string {
  const normalizedLines = content.replaceAll('\r\n', '\n').split('\n');
  if (normalizedLines.at(-1) === '') {
    normalizedLines.pop();
  }

  const entry = `${key}=${formatEnvFileValue(value)}`;
  let replaced = false;

  const updatedLines = normalizedLines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || match[1] !== key) {
      return line;
    }

    replaced = true;
    return entry;
  });

  if (!replaced) {
    updatedLines.push(entry);
  }

  return `${updatedLines.join('\n')}\n`;
}

export function renderDefaultUserServiceEnvironment(): string {
  return [
    '# jagc user overrides',
    '# Loaded after service.env.snapshot; values here win.',
    '#',
    '# Supported format: KEY=value (dotenv style).',
    '# Node does not expand shell vars here; use absolute paths.',
    '#',
    '# Example tool paths (uncomment + adjust):',
    '# PATH=/Users/you/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    '# UV_TOOL_BIN_DIR=/Users/you/.local/share/uv/tools/bin',
    '# PNPM_HOME=/Users/you/Library/pnpm',
    '# ASDF_DATA_DIR=/Users/you/.asdf',
    '# MISE_DATA_DIR=/Users/you/.local/share/mise',
    '',
  ].join('\n');
}

function formatEnvFileValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

async function captureShellEnvironment(shellPath: string): Promise<NodeJS.ProcessEnv | null> {
  for (const args of shellCaptureArgs(shellPath)) {
    const result = await runCommand(shellPath, args, {
      allowFailure: true,
      trimOutput: false,
      timeoutMs: shellEnvironmentCaptureTimeoutMs,
      env: {
        ...process.env,
        SHELL: shellPath,
      },
    });

    if (result.code !== 0) {
      continue;
    }

    const parsed = parseNullDelimitedEnvironment(result.stdout);
    if (Object.keys(parsed).length > 0) {
      return parsed;
    }
  }

  return null;
}

function shellCaptureArgs(shellPath: string): string[][] {
  const shellName = basename(shellPath);

  if (shellName === 'bash' || shellName === 'zsh') {
    return [
      ['-ilc', 'env -0'],
      ['-lc', 'env -0'],
    ];
  }

  return [['-lc', 'env -0']];
}

function parseNullDelimitedEnvironment(output: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const entry of output.split('\u0000')) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1);

    if (!isValidEnvironmentKey(key)) {
      continue;
    }

    env[key] = value;
  }

  return env;
}

function isValidEnvironmentKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function resolveUserShellPath(): string {
  const shell = process.env.SHELL?.trim();
  if (shell?.startsWith('/')) {
    return shell;
  }

  return '/bin/bash';
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
