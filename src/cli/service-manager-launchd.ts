import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServiceLogLevel, ServiceRunner } from './service-manager-types.js';

export interface LaunchAgentConfig {
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

export interface LaunchctlPrintState {
  loaded: boolean;
  running: boolean;
  pid: number | null;
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

export function buildPlistPath(launchAgentsDir: string, label: string): string {
  return join(launchAgentsDir, `${label}.plist`);
}

export function buildLaunchctlTarget(label: string, launchctlDomain?: string): string {
  const domain = launchctlDomain ?? resolveLaunchctlDomain();
  return `${domain}/${label}`;
}

export function resolveLaunchctlBootstrapDomain(launchctlTarget: string): string {
  return launchctlTarget.split('/').slice(0, 2).join('/');
}

export function resolveLaunchctlDomain(): string {
  if (typeof process.getuid !== 'function') {
    throw new Error('launchctl service management requires process.getuid() on this platform');
  }

  return `gui/${process.getuid()}`;
}

export async function readLaunchAgentServiceConnection(
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

export function isLaunchctlMissingServiceError(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes('could not find service') ||
    normalized.includes('no such process') ||
    normalized.includes('service already unloaded')
  );
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
