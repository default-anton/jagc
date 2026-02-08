import { access } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import type { RunExecutor } from '../server/executor.js';
import type { RunStore } from '../server/store.js';
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

export interface ThreadControlService {
  getThreadRuntimeState(threadKey: string): Promise<ThreadRuntimeState>;
  setThreadModel(threadKey: string, provider: string, modelId: string): Promise<ThreadRuntimeState>;
  setThreadThinkingLevel(threadKey: string, thinkingLevel: SupportedThinkingLevel): Promise<ThreadRuntimeState>;
  resetThreadSession(threadKey: string): Promise<void>;
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
    return controller.submit(run);
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
        const controller = new ThreadRunController(session);

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
    const result = await createAgentSession({
      cwd: this.options.workspaceDir,
      agentDir: this.options.workspaceDir,
      sessionManager,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settingsManager,
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
