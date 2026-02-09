import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  parseLaunchAgentServiceConnection,
  parseLaunchctlPrintOutput,
  renderLaunchAgentPlist,
  resolveServerEntrypoint,
} from '../src/cli/service-manager.js';

describe('resolveServerEntrypoint', () => {
  test('prefers dist/server/main.mjs when present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-service-manager-dist-'));

    try {
      const cliPath = join(root, 'dist/cli/main.mjs');
      const serverPath = join(root, 'dist/server/main.mjs');

      await mkdir(join(root, 'dist/cli'), { recursive: true });
      await mkdir(join(root, 'dist/server'), { recursive: true });
      await writeFile(cliPath, '#!/usr/bin/env node\n');
      await writeFile(serverPath, 'console.log("server");\n');

      await expect(resolveServerEntrypoint(cliPath)).resolves.toBe(serverPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('resolves dist/server/main.mjs for dev CLI path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-service-manager-src-'));

    try {
      const cliPath = join(root, 'src/cli/main.ts');
      const serverPath = join(root, 'dist/server/main.mjs');

      await mkdir(join(root, 'src/cli'), { recursive: true });
      await mkdir(join(root, 'dist/server'), { recursive: true });
      await writeFile(cliPath, '#!/usr/bin/env node\n');
      await writeFile(serverPath, 'console.log("server");\n');

      await expect(resolveServerEntrypoint(cliPath)).resolves.toBe(serverPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails with actionable error when no built server entrypoint is present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jagc-service-manager-missing-'));

    try {
      const cliPath = join(root, 'src/cli/main.ts');
      await mkdir(join(root, 'src/cli'), { recursive: true });
      await writeFile(cliPath, '#!/usr/bin/env node\n');

      await expect(resolveServerEntrypoint(cliPath)).rejects.toThrow("run 'pnpm build' and retry");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('renderLaunchAgentPlist', () => {
  test('renders environment + escaped values', () => {
    const plist = renderLaunchAgentPlist({
      label: 'com.jagc.test',
      nodePath: '/opt/homebrew/bin/node',
      serverEntrypoint: '/tmp/jagc/dist/server/main.mjs',
      workspaceDir: '/tmp/jagc/<workspace>',
      databasePath: '/tmp/jagc/db&name.sqlite',
      host: '127.0.0.1',
      port: 31415,
      runner: 'echo',
      logLevel: 'info',
      stdoutPath: '/tmp/jagc/logs/server.out.log',
      stderrPath: '/tmp/jagc/logs/server.err.log',
      telegramBotToken: 'abc<def>',
    });

    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>com.jagc.test</string>');
    expect(plist).toContain('<key>JAGC_RUNNER</key>');
    expect(plist).toContain('<string>echo</string>');
    expect(plist).toContain('/tmp/jagc/&lt;workspace&gt;');
    expect(plist).toContain('/tmp/jagc/db&amp;name.sqlite');
    expect(plist).toContain('abc&lt;def&gt;');
  });
});

describe('parseLaunchAgentServiceConnection', () => {
  test('parses host and port from launch agent environment variables', () => {
    const plist = renderLaunchAgentPlist({
      label: 'com.jagc.test',
      nodePath: '/opt/homebrew/bin/node',
      serverEntrypoint: '/tmp/jagc/dist/server/main.mjs',
      workspaceDir: '/tmp/jagc/workspace',
      databasePath: '/tmp/jagc/workspace/jagc.sqlite',
      host: '127.0.0.1',
      port: 31415,
      runner: 'pi',
      logLevel: 'info',
      stdoutPath: '/tmp/jagc/logs/server.out.log',
      stderrPath: '/tmp/jagc/logs/server.err.log',
    });

    expect(parseLaunchAgentServiceConnection(plist)).toEqual({
      host: '127.0.0.1',
      port: 31415,
    });
  });

  test('returns nulls when host/port are missing or invalid', () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>EnvironmentVariables</key>
    <dict>
      <key>JAGC_PORT</key>
      <string>nope</string>
    </dict>
  </dict>
</plist>`;

    expect(parseLaunchAgentServiceConnection(plist)).toEqual({
      host: null,
      port: null,
    });
  });
});

describe('parseLaunchctlPrintOutput', () => {
  test('parses running service state', () => {
    const state = parseLaunchctlPrintOutput(`
      gui/501/com.jagc.server = {
        active count = 1
        state = running
        pid = 4242
      }
    `);

    expect(state.loaded).toBe(true);
    expect(state.running).toBe(true);
    expect(state.pid).toBe(4242);
  });

  test('handles loaded-but-idle state', () => {
    const state = parseLaunchctlPrintOutput(`
      gui/501/com.jagc.server = {
        active count = 0
        state = waiting
      }
    `);

    expect(state.loaded).toBe(true);
    expect(state.running).toBe(false);
    expect(state.pid).toBeNull();
  });
});
