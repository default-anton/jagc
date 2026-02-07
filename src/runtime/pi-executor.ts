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

  private async getController(threadKey: string): Promise<ThreadRunController> {
    const existing = this.controllers.get(threadKey);
    if (existing) {
      return existing;
    }

    const pending = this.controllerCreation.get(threadKey);
    if (pending) {
      return pending;
    }

    const createControllerPromise = this.getSession(threadKey)
      .then((session) => {
        const controller = new ThreadRunController(session);
        this.controllers.set(threadKey, controller);
        this.controllerCreation.delete(threadKey);
        return controller;
      })
      .catch((error) => {
        this.controllerCreation.delete(threadKey);
        throw error;
      });

    this.controllerCreation.set(threadKey, createControllerPromise);
    return createControllerPromise;
  }

  private async getSession(threadKey: string): Promise<AgentSession> {
    const existing = this.sessions.get(threadKey);
    if (existing) {
      return existing;
    }

    const pending = this.sessionCreation.get(threadKey);
    if (pending) {
      return pending;
    }

    const createSessionPromise = this.createOrLoadSession(threadKey)
      .then((session) => {
        this.sessions.set(threadKey, session);
        this.sessionCreation.delete(threadKey);
        return session;
      })
      .catch((error) => {
        this.sessionCreation.delete(threadKey);
        throw error;
      });

    this.sessionCreation.set(threadKey, createSessionPromise);
    return createSessionPromise;
  }

  private async createOrLoadSession(threadKey: string): Promise<AgentSession> {
    const persisted = await this.runStore.getThreadSession(threadKey);

    if (persisted) {
      if (!(await fileExists(persisted.sessionFile))) {
        return this.createAndPersistNewSession(threadKey);
      }

      try {
        const opened = await this.createSession(SessionManager.open(persisted.sessionFile, this.sessionDir));
        await this.ensureThreadSession(threadKey, opened.sessionId, opened.sessionFile);
        return opened;
      } catch {
        return this.createAndPersistNewSession(threadKey);
      }
    }

    return this.createAndPersistNewSession(threadKey);
  }

  private async createAndPersistNewSession(threadKey: string): Promise<AgentSession> {
    const created = await this.createSession(SessionManager.create(this.options.workspaceDir, this.sessionDir));
    await this.ensureThreadSession(threadKey, created.sessionId, created.sessionFile);
    return created;
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
  ): Promise<void> {
    if (!sessionFile) {
      throw new Error(`session ${sessionId} for thread ${threadKey} has no session file`);
    }

    await this.runStore.upsertThreadSession(threadKey, sessionId, sessionFile);
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
