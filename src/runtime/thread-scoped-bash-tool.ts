import { type BashOperations, createBashTool } from '@mariozechner/pi-coding-agent';

import { withThreadToolEnvironment } from './thread-tool-environment.js';

export function createThreadScopedBashToolDefinition(cwd: string, threadKey: string, operations?: BashOperations) {
  return createBashTool(cwd, {
    operations,
    spawnHook: ({ command, cwd: commandCwd, env }) => ({
      command,
      cwd: commandCwd,
      env: withThreadToolEnvironment(env, threadKey),
    }),
  });
}
