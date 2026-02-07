#!/usr/bin/env node

import { Command, InvalidArgumentError, Option } from 'commander';

import { getAuthProviders, healthcheck, sendMessage, waitForRun } from './client.js';

const defaultApiUrl = process.env.JAGC_API_URL ?? 'http://127.0.0.1:31415';

const program = new Command();
program
  .name('jagc')
  .description('jagc command line interface')
  .showHelpAfterError()
  .option('--api-url <url>', 'jagc server API URL', defaultApiUrl);

program
  .command('health')
  .option('--json', 'JSON output')
  .action(async (options) => {
    try {
      await healthcheck(apiUrl(program));

      if (options.json) {
        printJson({ ok: true });
      } else {
        console.log('ok');
      }
    } catch (error) {
      exitWithError(error);
    }
  });

program
  .command('message')
  .argument('<text>', 'message text')
  .option('--source <source>', 'message source', 'cli')
  .option('--thread-key <threadKey>', 'message thread key', 'cli:default')
  .option('--user-key <userKey>', 'message user key')
  .addOption(
    new Option('--delivery-mode <mode>', 'delivery mode while a run is active')
      .choices(['steer', 'followUp'])
      .default('followUp'),
  )
  .option('--idempotency-key <key>', 'idempotency key')
  .option('--json', 'JSON output')
  .action(async (text, options) => {
    try {
      const run = await sendMessage(apiUrl(program), {
        source: options.source,
        thread_key: options.threadKey,
        user_key: options.userKey,
        text,
        delivery_mode: options.deliveryMode,
        idempotency_key: options.idempotencyKey,
      });

      if (options.json) {
        printJson(run);
      } else {
        console.log(run.run_id);
      }
    } catch (error) {
      exitWithError(error);
    }
  });

const authCommand = program.command('auth');

authCommand
  .command('providers')
  .option('--json', 'JSON output')
  .action(async (options) => {
    try {
      const status = await getAuthProviders(apiUrl(program));

      if (options.json) {
        printJson(status);
      } else {
        for (const provider of status.providers) {
          const auth = provider.has_auth ? provider.credential_type : 'missing';
          const envHint = provider.env_var_hint ? ` env:${provider.env_var_hint}` : '';
          console.log(
            `${provider.provider} auth:${auth} models:${provider.available_models}/${provider.total_models}${envHint}`,
          );
        }
      }
    } catch (error) {
      exitWithError(error);
    }
  });

const runCommand = program.command('run');

runCommand
  .command('wait')
  .argument('<runId>', 'run ID')
  .option('--timeout <seconds>', 'timeout in seconds', parsePositiveNumber, 60)
  .option('--interval-ms <ms>', 'poll interval milliseconds', parsePositiveNumber, 500)
  .option('--json', 'JSON output')
  .action(async (runId, options: { timeout: number; intervalMs: number; json?: boolean }) => {
    try {
      const run = await waitForRun(apiUrl(program), runId, options.timeout * 1000, options.intervalMs);

      if (options.json) {
        printJson(run);
      } else if (run.error?.message) {
        console.log(`${run.run_id} ${run.status} ${run.error.message}`);
      } else {
        console.log(`${run.run_id} ${run.status}`);
      }
    } catch (error) {
      exitWithError(error);
    }
  });

await program.parseAsync(process.argv);

function apiUrl(root: Command): string {
  return root.opts<{ apiUrl: string }>().apiUrl;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parsePositiveNumber(value: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('must be a positive number');
  }

  return parsed;
}

function exitWithError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
