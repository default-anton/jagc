import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import type { RunExecutor } from '../server/executor.js';
import type { RunStore } from '../server/store.js';
import type { RunProgressEvent, RunProgressListener } from '../shared/run-progress.js';
import type { RunOutput, RunRecord } from '../shared/run-types.js';
import { ThreadRunController } from './thread-run-controller.js';

interface PiExecutorOptions {
  workspaceDir: string;
  sessionDir?: string;
}

export const supportedThinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type SupportedThinkingLevel = (typeof supportedThinkingLevels)[number];

export interface ThreadRuntimeState {
  threadKey: string;
  model: {
    provider: string;
    modelId: string;
    name: string | null;
  } | null;
  thinkingLevel: SupportedThinkingLevel;
  supportsThinking: boolean;
  availableThinkingLevels: SupportedThinkingLevel[];
}

export interface ThreadShareResult {
  threadKey: string;
  gistUrl: string;
  shareUrl: string;
}

export interface ThreadCancelResult {
  threadKey: string;
  cancelled: boolean;
}

export interface ThreadControlService {
  getThreadRuntimeState(threadKey: string): Promise<ThreadRuntimeState>;
  setThreadModel(threadKey: string, provider: string, modelId: string): Promise<ThreadRuntimeState>;
  setThreadThinkingLevel(threadKey: string, thinkingLevel: SupportedThinkingLevel): Promise<ThreadRuntimeState>;
  cancelThreadRun(threadKey: string): Promise<ThreadCancelResult>;
  resetThreadSession(threadKey: string): Promise<void>;
  shareThreadSession(threadKey: string): Promise<ThreadShareResult>;
}

const threadResetTimeoutMs = 10_000;

class ThreadGenerationMismatchError extends Error {
  constructor(threadKey: string) {
    super(`thread ${threadKey} was reset while an operation was in progress`);
  }
}

export class PiRunExecutor implements RunExecutor, ThreadControlService {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly sessionCreation = new Map<string, Promise<AgentSession>>();
  private readonly controllers = new Map<string, ThreadRunController>();
  private readonly controllerCreation = new Map<string, Promise<ThreadRunController>>();
  private readonly sessionDir: string;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly settingsManager: SettingsManager;
  private readonly threadGeneration = new Map<string, number>();
  private readonly resetInFlight = new Map<string, Promise<void>>();
  private runProgressListener: RunProgressListener | null = null;

  constructor(
    private readonly runStore: RunStore,
    private readonly options: PiExecutorOptions,
  ) {
    this.sessionDir = options.sessionDir ?? join(options.workspaceDir, '.sessions');
    this.authStorage = new AuthStorage(join(options.workspaceDir, 'auth.json'));
    this.modelRegistry = new ModelRegistry(this.authStorage, join(options.workspaceDir, 'models.json'));
    this.settingsManager = SettingsManager.create(options.workspaceDir, options.workspaceDir);
  }

  async execute(run: RunRecord): Promise<RunOutput> {
    const controller = await this.getController(run.threadKey);
    const generation = this.getThreadGeneration(run.threadKey);

    try {
      return await controller.submit(run);
    } finally {
      await this.reconcilePersistedThreadSession(run.threadKey, generation);
    }
  }

  setRunProgressListener(listener: RunProgressListener | null): void {
    this.runProgressListener = listener;
  }

  async getThreadRuntimeState(threadKey: string): Promise<ThreadRuntimeState> {
    const session = await this.getSession(threadKey);
    return stateFromSession(threadKey, session);
  }

  async setThreadModel(threadKey: string, provider: string, modelId: string): Promise<ThreadRuntimeState> {
    this.authStorage.reload();
    this.modelRegistry.refresh();

    const model = this.modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(`model ${provider}/${modelId} is not available in registry`);
    }

    const session = await this.getSession(threadKey);
    await session.setModel(model);

    return stateFromSession(threadKey, session);
  }

  async setThreadThinkingLevel(threadKey: string, thinkingLevel: SupportedThinkingLevel): Promise<ThreadRuntimeState> {
    const session = await this.getSession(threadKey);
    session.setThinkingLevel(thinkingLevel);

    return stateFromSession(threadKey, session);
  }

  async cancelThreadRun(threadKey: string): Promise<ThreadCancelResult> {
    await this.waitForInFlightReset(threadKey);

    const pendingSession = this.sessionCreation.get(threadKey);
    if (pendingSession) {
      await awaitWithTimeout(
        pendingSession.catch(() => undefined),
        threadResetTimeoutMs,
        `timed out waiting for session creation before cancelling thread ${threadKey}`,
      );
    }

    const session = this.sessions.get(threadKey);
    if (!session) {
      return {
        threadKey,
        cancelled: false,
      };
    }

    const hasActiveWork = session.isStreaming || session.pendingMessageCount > 0;
    if (!hasActiveWork) {
      return {
        threadKey,
        cancelled: false,
      };
    }

    try {
      await awaitWithTimeout(
        session.abort(),
        threadResetTimeoutMs,
        `timed out aborting active run for thread ${threadKey}`,
      );
    } catch (error) {
      throw new Error(`failed to cancel active run for thread ${threadKey}: ${errorMessage(error)}`);
    }

    return {
      threadKey,
      cancelled: true,
    };
  }

  async resetThreadSession(threadKey: string): Promise<void> {
    const existingReset = this.resetInFlight.get(threadKey);
    if (existingReset) {
      await awaitWithTimeout(existingReset, threadResetTimeoutMs, `timed out waiting for reset of thread ${threadKey}`);
      return;
    }

    let resolveReset: () => void = () => {};
    const resetPromise = new Promise<void>((resolve) => {
      resolveReset = resolve;
    });

    this.resetInFlight.set(threadKey, resetPromise);
    this.bumpThreadGeneration(threadKey);

    const pendingController = this.controllerCreation.get(threadKey);
    const pendingSession = this.sessionCreation.get(threadKey);

    const controller = this.controllers.get(threadKey);
    this.controllers.delete(threadKey);
    this.controllerCreation.delete(threadKey);

    const session = this.sessions.get(threadKey);
    this.sessions.delete(threadKey);
    this.sessionCreation.delete(threadKey);

    try {
      controller?.dispose();

      if (session) {
        await awaitWithTimeout(
          session.abort().catch(() => undefined),
          threadResetTimeoutMs,
          `timed out aborting session for thread ${threadKey}`,
        );
        session.dispose();
      }

      if (pendingController) {
        await awaitWithTimeout(
          pendingController.catch(() => undefined),
          threadResetTimeoutMs,
          `timed out waiting for controller creation cleanup for thread ${threadKey}`,
        );
      }

      if (pendingSession) {
        await awaitWithTimeout(
          pendingSession.catch(() => undefined),
          threadResetTimeoutMs,
          `timed out waiting for session creation cleanup for thread ${threadKey}`,
        );
      }

      await awaitWithTimeout(
        this.runStore.deleteThreadSession(threadKey),
        threadResetTimeoutMs,
        `timed out clearing persisted session mapping for thread ${threadKey}`,
      );
    } finally {
      this.resetInFlight.delete(threadKey);
      resolveReset();
    }
  }

  async shareThreadSession(threadKey: string): Promise<ThreadShareResult> {
    await ensureGitHubCliAuthenticated();
    const shareViewerBaseUrl = resolveShareViewerBaseUrl();
    const session = await this.getSession(threadKey);

    const tempDirectory = await mkdtemp(join(tmpdir(), 'jagc-share-'));
    const tempFile = join(tempDirectory, 'session.html');

    try {
      await session.exportToHtml(tempFile);

      const gistUrl = await createSecretGist(tempFile);
      const gistId = extractGistId(gistUrl);
      const shareUrl = getShareViewerUrl(shareViewerBaseUrl, gistId);

      return {
        threadKey,
        gistUrl,
        shareUrl,
      };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  private async getController(threadKey: string): Promise<ThreadRunController> {
    await this.waitForInFlightReset(threadKey);

    const existing = this.controllers.get(threadKey);
    if (existing) {
      return existing;
    }

    const pending = this.controllerCreation.get(threadKey);
    if (pending) {
      return pending;
    }

    const generation = this.getThreadGeneration(threadKey);

    const createControllerPromise = this.getSession(threadKey)
      .then((session) => {
        const controller = new ThreadRunController(session, {
          onProgress: (event) => {
            this.handleRunProgressEvent(event);
          },
        });

        try {
          this.assertThreadGeneration(threadKey, generation);
        } catch (error) {
          controller.dispose();
          throw error;
        }

        this.controllers.set(threadKey, controller);
        return controller;
      })
      .finally(() => {
        this.controllerCreation.delete(threadKey);
      });

    this.controllerCreation.set(threadKey, createControllerPromise);
    return createControllerPromise;
  }

  private async getSession(threadKey: string): Promise<AgentSession> {
    await this.waitForInFlightReset(threadKey);

    const existing = this.sessions.get(threadKey);
    if (existing) {
      return existing;
    }

    const pending = this.sessionCreation.get(threadKey);
    if (pending) {
      return pending;
    }

    const generation = this.getThreadGeneration(threadKey);

    const createSessionPromise = this.createOrLoadSession(threadKey, generation)
      .then((session) => {
        try {
          this.assertThreadGeneration(threadKey, generation);
        } catch (error) {
          session.dispose();
          throw error;
        }

        this.sessions.set(threadKey, session);
        return session;
      })
      .finally(() => {
        this.sessionCreation.delete(threadKey);
      });

    this.sessionCreation.set(threadKey, createSessionPromise);
    return createSessionPromise;
  }

  private async createOrLoadSession(threadKey: string, generation: number): Promise<AgentSession> {
    const persisted = await this.runStore.getThreadSession(threadKey);

    if (persisted) {
      if (!(await fileExists(persisted.sessionFile))) {
        return this.createAndPersistNewSession(threadKey, generation);
      }

      try {
        const opened = await this.createSession(SessionManager.open(persisted.sessionFile, this.sessionDir));

        try {
          await this.ensureThreadSession(threadKey, opened.sessionId, opened.sessionFile, generation);
          return opened;
        } catch (error) {
          opened.dispose();
          throw error;
        }
      } catch (error) {
        if (error instanceof ThreadGenerationMismatchError) {
          throw error;
        }

        return this.createAndPersistNewSession(threadKey, generation);
      }
    }

    return this.createAndPersistNewSession(threadKey, generation);
  }

  private async createAndPersistNewSession(threadKey: string, generation: number): Promise<AgentSession> {
    const created = await this.createSession(SessionManager.create(this.options.workspaceDir, this.sessionDir));

    try {
      await this.ensureThreadSession(threadKey, created.sessionId, created.sessionFile, generation);
      return created;
    } catch (error) {
      created.dispose();
      throw error;
    }
  }

  private async createSession(sessionManager: SessionManager): Promise<AgentSession> {
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.options.workspaceDir,
      agentDir: this.options.workspaceDir,
      settingsManager: this.settingsManager,
      noSkills: true,
      agentsFilesOverride: () => ({
        agentsFiles: [],
      }),
    });
    await resourceLoader.reload();

    const result = await createAgentSession({
      cwd: this.options.workspaceDir,
      agentDir: this.options.workspaceDir,
      sessionManager,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settingsManager,
      resourceLoader,
    });

    return result.session;
  }

  private async ensureThreadSession(
    threadKey: string,
    sessionId: string,
    sessionFile: string | undefined,
    generation: number,
  ): Promise<void> {
    this.assertThreadGeneration(threadKey, generation);

    if (!sessionFile) {
      throw new Error(`session ${sessionId} for thread ${threadKey} has no session file`);
    }

    await this.runStore.upsertThreadSession(threadKey, sessionId, sessionFile);
  }

  private async reconcilePersistedThreadSession(threadKey: string, generation: number): Promise<void> {
    const session = this.sessions.get(threadKey);
    if (!session) {
      return;
    }

    try {
      await this.ensureThreadSession(threadKey, session.sessionId, session.sessionFile, generation);
    } catch (error) {
      if (error instanceof ThreadGenerationMismatchError) {
        return;
      }

      throw error;
    }
  }

  private handleRunProgressEvent(event: RunProgressEvent): void {
    this.runProgressListener?.(event);
  }

  private async waitForInFlightReset(threadKey: string): Promise<void> {
    const inFlightReset = this.resetInFlight.get(threadKey);
    if (!inFlightReset) {
      return;
    }

    await awaitWithTimeout(
      inFlightReset,
      threadResetTimeoutMs,
      `timed out waiting for in-flight reset of thread ${threadKey}`,
    );
  }

  private getThreadGeneration(threadKey: string): number {
    return this.threadGeneration.get(threadKey) ?? 0;
  }

  private bumpThreadGeneration(threadKey: string): number {
    const nextGeneration = this.getThreadGeneration(threadKey) + 1;
    this.threadGeneration.set(threadKey, nextGeneration);
    return nextGeneration;
  }

  private assertThreadGeneration(threadKey: string, expectedGeneration: number): void {
    if (this.getThreadGeneration(threadKey) !== expectedGeneration) {
      throw new ThreadGenerationMismatchError(threadKey);
    }
  }
}

const defaultShareViewerUrl = 'https://pi.dev/session/';
const ghAuthStatusTimeoutMs = 10_000;
const ghGistCreateTimeoutMs = 30_000;

function resolveShareViewerBaseUrl(): URL {
  const configured = process.env.PI_SHARE_VIEWER_URL?.trim();
  const rawBaseUrl = configured && configured.length > 0 ? configured : defaultShareViewerUrl;

  try {
    return new URL(rawBaseUrl);
  } catch {
    throw new Error(`PI_SHARE_VIEWER_URL must be an absolute URL. Received: ${rawBaseUrl}`);
  }
}

function getShareViewerUrl(baseUrl: URL, gistId: string): string {
  const shareUrl = new URL(baseUrl.toString());
  shareUrl.hash = gistId;
  return shareUrl.toString();
}

async function ensureGitHubCliAuthenticated(): Promise<void> {
  const authResult = await runCommand('gh', ['auth', 'status'], {
    timeoutMs: ghAuthStatusTimeoutMs,
    env: {
      GH_PROMPT_DISABLED: '1',
    },
  });

  if (authResult.error) {
    if (authResult.error.code === 'ENOENT') {
      throw new Error('GitHub CLI (gh) is not installed. Install it from https://cli.github.com/');
    }

    throw new Error(`failed to run GitHub CLI auth check: ${authResult.error.message}`);
  }

  if (authResult.timedOut) {
    throw new Error(`timed out checking GitHub CLI auth status after ${ghAuthStatusTimeoutMs}ms`);
  }

  if (authResult.code !== 0) {
    const details = authResult.stderr || authResult.stdout;
    if (details.length > 0) {
      throw new Error(`GitHub CLI auth check failed. ${details}`);
    }

    throw new Error("GitHub CLI is not logged in. Run 'gh auth login' first.");
  }
}

async function createSecretGist(filePath: string): Promise<string> {
  const result = await runCommand('gh', ['gist', 'create', filePath], {
    timeoutMs: ghGistCreateTimeoutMs,
    env: {
      GH_PROMPT_DISABLED: '1',
    },
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('GitHub CLI (gh) is not installed. Install it from https://cli.github.com/');
    }

    throw new Error(`failed to run GitHub CLI gist create: ${result.error.message}`);
  }

  if (result.timedOut) {
    throw new Error(`timed out creating secret gist after ${ghGistCreateTimeoutMs}ms`);
  }

  if (result.code !== 0) {
    throw new Error(`failed to create secret gist: ${result.stderr || 'Unknown error'}`);
  }

  const gistUrl = extractFirstUrl(result.stdout);
  if (!gistUrl) {
    throw new Error('failed to create secret gist: no URL in gh output');
  }

  return gistUrl;
}

interface RunCommandOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface RunCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: NodeJS.ErrnoException | null;
}

async function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<RunCommandResult> {
  const timeoutMs = options.timeoutMs;
  const env = options.env ? { ...process.env, ...options.env } : undefined;

  return await new Promise<RunCommandResult>((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let error: NodeJS.ErrnoException | null = null;
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      resolvePromise({
        code: timedOut ? 124 : (code ?? 1),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        error,
      });
    };

    const timeoutHandle =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stderr += `${stderr ? '\n' : ''}command timed out after ${timeoutMs}ms`;
            child.kill('SIGKILL');
          }, timeoutMs)
        : null;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (spawnError) => {
      error = spawnError as NodeJS.ErrnoException;
      finish(1);
    });

    child.on('close', (code) => {
      finish(code);
    });
  });
}

function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/);
  if (!match) {
    return null;
  }

  return match[0] ?? null;
}

function extractGistId(gistUrl: string): string {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(gistUrl);
  } catch {
    throw new Error(`failed to parse gist URL from gh output: ${gistUrl}`);
  }

  const segments = parsedUrl.pathname.split('/').filter((segment) => segment.length > 0);
  const gistId = segments[segments.length - 1];

  if (!gistId) {
    throw new Error(`failed to parse gist ID from gh output: ${gistUrl}`);
  }

  return gistId;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}

function stateFromSession(threadKey: string, session: AgentSession): ThreadRuntimeState {
  const model = session.model
    ? {
        provider: session.model.provider,
        modelId: session.model.id,
        name: session.model.name ?? null,
      }
    : null;

  return {
    threadKey,
    model,
    thinkingLevel: session.thinkingLevel as SupportedThinkingLevel,
    supportsThinking: session.supportsThinking(),
    availableThinkingLevels: session.getAvailableThinkingLevels() as SupportedThinkingLevel[],
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
