#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Command, InvalidArgumentError, Option } from 'commander';

import { type OAuthLoginAttemptResponse, type OAuthLoginPromptKind, thinkingLevels } from '../shared/api-contracts.js';
import { InputImageValidationError } from '../shared/input-images.js';
import {
  cancelThreadRun,
  getAuthProviders,
  getModelCatalog,
  getOAuthLoginAttempt,
  getThreadRuntime,
  healthcheck,
  resetThreadSession,
  sendMessage,
  setThreadModel,
  setThreadThinkingLevel,
  shareThreadSession,
  startOAuthLogin,
  submitOAuthLoginInput,
  waitForRun,
} from './client.js';
import { exitWithError, parsePositiveNumber, printJson } from './common.js';
import { registerDefaultsCommands } from './defaults-commands.js';
import { buildMessageImagesFromPaths } from './message-images.js';
import { registerPackagesCommands } from './packages-commands.js';
import { registerServiceCommands } from './service-commands.js';
import { registerTaskCommands } from './task-commands.js';
import { registerTelegramCommands } from './telegram-commands.js';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
  version: string;
};
const version = packageJson.version;
const defaultApiUrl = process.env.JAGC_API_URL ?? 'http://127.0.0.1:31415';
const defaultThreadKey = 'cli:default';

const program = new Command();
program
  .name('jagc')
  .description('jagc command line interface')
  .version(version, '-v, --version', 'output the version number')
  .showHelpAfterError()
  .option('--api-url <url>', 'jagc server API URL', defaultApiUrl);

program
  .command('health')
  .description('check jagc API health')
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

registerServiceCommands(program);
registerDefaultsCommands(program);
registerPackagesCommands(program);
registerTelegramCommands(program);
registerTaskCommands(program);

program
  .command('message')
  .description('enqueue a thread message and start a run')
  .argument('<text>', 'message text')
  .option('--source <source>', 'message source', 'cli')
  .option('--thread-key <threadKey>', 'message thread key', defaultThreadKey)
  .option('--user-key <userKey>', 'message user key')
  .addOption(
    new Option('--delivery-mode <mode>', 'delivery mode while a run is active')
      .choices(['steer', 'followUp'])
      .default('followUp'),
  )
  .option('-i, --image <path>', 'attach image file (repeatable)', collectValues, [] as string[])
  .option('--idempotency-key <key>', 'idempotency key')
  .option('--json', 'JSON output')
  .action(async (text, options: MessageCommandOptions) => {
    try {
      const images = await buildMessageImagesFromPaths(options.image);
      const run = await sendMessage(apiUrl(program), {
        source: options.source,
        thread_key: options.threadKey,
        user_key: options.userKey,
        text,
        delivery_mode: options.deliveryMode,
        idempotency_key: options.idempotencyKey,
        ...(images.length > 0 ? { images } : {}),
      });

      if (options.json) {
        printJson(run);
      } else {
        console.log(run.run_id);
      }
    } catch (error) {
      if (error instanceof InputImageValidationError) {
        return exitWithError(new Error(`${error.code}: ${error.message}`), { json: options.json });
      }

      exitWithError(error, { json: options.json });
    }
  });

program
  .command('cancel')
  .description('cancel active thread run without resetting session context')
  .option('--thread-key <threadKey>', 'thread key', defaultThreadKey)
  .option('--json', 'JSON output')
  .action(async (options) => {
    try {
      const response = await cancelThreadRun(apiUrl(program), options.threadKey);

      if (options.json) {
        printJson(response);
      } else if (response.cancelled) {
        console.log(`thread:${response.thread_key} run stopped (session preserved)`);
      } else {
        console.log(`thread:${response.thread_key} no active run to stop (session preserved)`);
      }
    } catch (error) {
      exitWithError(error);
    }
  });

program
  .command('new')
  .description('reset thread session so the next message starts a fresh pi session')
  .option('--thread-key <threadKey>', 'thread key', defaultThreadKey)
  .option('--json', 'JSON output')
  .action(async (options) => {
    try {
      const response = await resetThreadSession(apiUrl(program), options.threadKey);

      if (options.json) {
        printJson(response);
      } else {
        console.log(`thread:${response.thread_key} session reset`);
      }
    } catch (error) {
      exitWithError(error);
    }
  });

program
  .command('share')
  .description('export thread session HTML and upload as a secret GitHub gist')
  .option('--thread-key <threadKey>', 'thread key', defaultThreadKey)
  .option('--json', 'JSON output')
  .action(async (options) => {
    try {
      const response = await shareThreadSession(apiUrl(program), options.threadKey);

      if (options.json) {
        printJson(response);
      } else {
        console.log(`thread:${response.thread_key}`);
        console.log(`share:${response.share_url}`);
        console.log(`gist:${response.gist_url}`);
      }
    } catch (error) {
      exitWithError(error);
    }
  });

const authCommand = program.command('auth').description('manage provider authentication');

authCommand
  .command('providers')
  .description('list provider auth status and model availability')
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
          const oauth = provider.oauth_supported ? 'yes' : 'no';
          console.log(
            `${provider.provider} auth:${auth} oauth:${oauth} models:${provider.available_models}/${provider.total_models}${envHint}`,
          );
        }
      }
    } catch (error) {
      exitWithError(error);
    }
  });

authCommand
  .command('login')
  .description('start interactive OAuth login for a provider')
  .argument('<provider>', 'OAuth provider id (for example: openai-codex)')
  .option('--owner-key <key>', 'stable owner key for resuming the same login flow across retries')
  .option('--poll-interval-ms <ms>', 'poll interval milliseconds', parsePositiveNumber, 1000)
  .option('--json', 'JSON output')
  .action(async (provider, options: { ownerKey?: string; pollIntervalMs: number; json?: boolean }) => {
    try {
      const initialAttempt = await startOAuthLogin(apiUrl(program), provider, options.ownerKey);

      if (!options.json) {
        process.stderr.write(`OAuth attempt: ${initialAttempt.attempt_id} owner:${initialAttempt.owner_key}\n`);
      }

      const finalAttempt = await completeOAuthLogin(apiUrl(program), initialAttempt, {
        pollIntervalMs: options.pollIntervalMs,
      });

      if (options.json) {
        printJson(finalAttempt);
      } else {
        console.log(`Logged in to ${finalAttempt.provider}.`);
      }
    } catch (error) {
      exitWithError(error);
    }
  });

const modelCommand = program.command('model').description('inspect and change thread model');

modelCommand
  .command('list')
  .description('list providers and models available to jagc')
  .option('--json', 'JSON output')
  .action(async (options) => {
    try {
      const catalog = await getModelCatalog(apiUrl(program));

      if (options.json) {
        printJson(catalog);
      } else {
        for (const provider of catalog.providers) {
          const auth = provider.has_auth ? provider.credential_type : 'missing';
          console.log(`${provider.provider} auth:${auth} models:${provider.available_models}/${provider.total_models}`);

          for (const model of provider.models) {
            const availability = model.available ? '*' : '-';
            const reasoning = model.reasoning ? ' reasoning' : '';
            console.log(`  ${availability} ${model.provider}/${model.model_id}${reasoning}`);
          }
        }
      }
    } catch (error) {
      exitWithError(error);
    }
  });

modelCommand
  .command('get')
  .description('show the current model for a thread')
  .option('--thread-key <threadKey>', 'thread key', defaultThreadKey)
  .option('--json', 'JSON output')
  .action(async (options) => {
    try {
      const state = await getThreadRuntime(apiUrl(program), options.threadKey);

      if (options.json) {
        printJson(state);
      } else if (!state.model) {
        console.log(`thread:${state.thread_key} model:(none)`);
      } else {
        console.log(`thread:${state.thread_key} model:${state.model.provider}/${state.model.model_id}`);
      }
    } catch (error) {
      exitWithError(error);
    }
  });

modelCommand
  .command('set')
  .description('set the model for a thread')
  .argument('<providerModel>', 'model in provider/model format')
  .option('--thread-key <threadKey>', 'thread key', defaultThreadKey)
  .option('--json', 'JSON output')
  .action(async (providerModel, options) => {
    try {
      const parsed = parseProviderModel(providerModel);
      const state = await setThreadModel(apiUrl(program), options.threadKey, {
        provider: parsed.provider,
        model_id: parsed.modelId,
      });

      if (options.json) {
        printJson(state);
      } else if (!state.model) {
        console.log(`thread:${state.thread_key} model:(none)`);
      } else {
        console.log(`thread:${state.thread_key} model:${state.model.provider}/${state.model.model_id}`);
      }
    } catch (error) {
      exitWithError(error);
    }
  });

const thinkingCommand = program.command('thinking').description('inspect and change thread thinking level');

thinkingCommand
  .command('get')
  .description('show the current thinking level for a thread')
  .option('--thread-key <threadKey>', 'thread key', defaultThreadKey)
  .option('--json', 'JSON output')
  .action(async (options) => {
    try {
      const state = await getThreadRuntime(apiUrl(program), options.threadKey);

      if (options.json) {
        printJson({
          thread_key: state.thread_key,
          thinking_level: state.thinking_level,
          supports_thinking: state.supports_thinking,
          available_thinking_levels: state.available_thinking_levels,
        });
      } else {
        console.log(`thread:${state.thread_key} thinking:${state.thinking_level}`);
      }
    } catch (error) {
      exitWithError(error);
    }
  });

thinkingCommand
  .command('set')
  .description('set the thinking level for a thread')
  .argument('<level>', `thinking level (${thinkingLevels.join(', ')})`)
  .option('--thread-key <threadKey>', 'thread key', defaultThreadKey)
  .option('--json', 'JSON output')
  .action(async (level, options) => {
    try {
      if (!isThinkingLevel(level)) {
        throw new InvalidArgumentError(`thinking level must be one of: ${thinkingLevels.join(', ')}`);
      }

      const state = await setThreadThinkingLevel(apiUrl(program), options.threadKey, {
        thinking_level: level,
      });

      if (options.json) {
        printJson({
          thread_key: state.thread_key,
          thinking_level: state.thinking_level,
          supports_thinking: state.supports_thinking,
          available_thinking_levels: state.available_thinking_levels,
        });
      } else {
        console.log(`thread:${state.thread_key} thinking:${state.thinking_level}`);
      }
    } catch (error) {
      exitWithError(error);
    }
  });

const runCommand = program.command('run').description('inspect and control run lifecycle');

runCommand
  .command('wait')
  .description('wait for a run to reach a terminal status')
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

function parseProviderModel(input: string): { provider: string; modelId: string } {
  const trimmed = input.trim();
  const separatorIndex = trimmed.indexOf('/');

  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw new InvalidArgumentError('model must be in provider/model format');
  }

  return {
    provider: trimmed.slice(0, separatorIndex),
    modelId: trimmed.slice(separatorIndex + 1),
  };
}

function isThinkingLevel(value: string): value is (typeof thinkingLevels)[number] {
  return thinkingLevels.includes(value as (typeof thinkingLevels)[number]);
}

interface MessageCommandOptions {
  source: string;
  threadKey: string;
  userKey?: string;
  deliveryMode: 'steer' | 'followUp';
  image: string[];
  idempotencyKey?: string;
  json?: boolean;
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function completeOAuthLogin(
  apiUrl: string,
  initialAttempt: OAuthLoginAttemptResponse,
  options: { pollIntervalMs: number },
): Promise<OAuthLoginAttemptResponse> {
  let attempt = initialAttempt;
  let promptInterface: Interface | null = null;
  let emittedProgressCount = 0;
  let lastAuthSignature: string | null = null;

  try {
    while (true) {
      if (attempt.auth) {
        const signature = `${attempt.auth.url}\n${attempt.auth.instructions ?? ''}`;
        if (signature !== lastAuthSignature) {
          process.stderr.write(`Open this URL to continue login:\n${attempt.auth.url}\n`);
          if (attempt.auth.instructions) {
            process.stderr.write(`${attempt.auth.instructions}\n`);
          }
          lastAuthSignature = signature;
        }
      }

      while (emittedProgressCount < attempt.progress_messages.length) {
        process.stderr.write(`${attempt.progress_messages[emittedProgressCount]}\n`);
        emittedProgressCount += 1;
      }

      if (attempt.status === 'succeeded') {
        return attempt;
      }

      if (attempt.status === 'failed') {
        throw new Error(attempt.error ?? `OAuth login failed for ${attempt.provider}`);
      }

      if (attempt.status === 'cancelled') {
        throw new Error(attempt.error ?? 'OAuth login was cancelled');
      }

      if (attempt.status === 'awaiting_input' && attempt.prompt) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new Error('OAuth login requires interactive input, but this terminal is not interactive');
        }

        if (!promptInterface) {
          promptInterface = createInterface({
            input: process.stdin,
            output: process.stderr,
          });
        }

        const inputValue = await promptForOAuthInput(promptInterface, attempt.prompt.kind, attempt.prompt.message);
        if (inputValue.trim().length === 0) {
          attempt = await getOAuthLoginAttempt(apiUrl, attempt.attempt_id, attempt.owner_key);
          continue;
        }

        try {
          attempt = await submitOAuthLoginInput(apiUrl, attempt.attempt_id, attempt.owner_key, {
            kind: attempt.prompt.kind,
            value: inputValue,
          });
        } catch (error) {
          if (!isOAuthInputRaceError(error)) {
            throw error;
          }

          const refreshedAttempt = await getOAuthLoginAttempt(apiUrl, attempt.attempt_id, attempt.owner_key);
          if (refreshedAttempt.status === 'succeeded') {
            process.stderr.write('OAuth login already completed in browser.\n');
            return refreshedAttempt;
          }

          if (refreshedAttempt.status !== 'awaiting_input') {
            attempt = refreshedAttempt;
            continue;
          }

          process.stderr.write('OAuth login state changed while you were typing. Try again.\n');
          attempt = refreshedAttempt;
        }

        continue;
      }

      await sleep(options.pollIntervalMs);
      attempt = await getOAuthLoginAttempt(apiUrl, attempt.attempt_id, attempt.owner_key);
    }
  } finally {
    promptInterface?.close();
  }
}

async function promptForOAuthInput(
  promptInterface: Interface,
  kind: OAuthLoginPromptKind,
  message: string,
): Promise<string> {
  const hint = kind === 'manual_code' ? 'Press Enter to refresh status if browser already completed.' : '';
  const prefix = kind === 'manual_code' ? 'code/url' : 'input';
  const instruction = hint ? `${message}\n${hint}\n${prefix}> ` : `${message}\n${prefix}> `;
  return promptInterface.question(instruction);
}

function isOAuthInputRaceError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes('not waiting for input') || error.message.includes('expects');
}
