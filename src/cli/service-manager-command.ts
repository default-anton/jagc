import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(
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
