import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { type AgentSession, createAgentSession, SessionManager } from '@mariozechner/pi-coding-agent';
import type { RunExecutor } from '../server/executor.js';
import type { RunStore } from '../server/store.js';
import type { RunOutput, RunRecord } from '../shared/run-types.js';
import { ThreadRunController } from './thread-run-controller.js';

interface PiExecutorOptions {
  workspaceDir: string;
  sessionDir?: string;
}

export class PiRunExecutor implements RunExecutor {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly sessionCreation = new Map<string, Promise<AgentSession>>();
  private readonly controllers = new Map<string, ThreadRunController>();
  private readonly controllerCreation = new Map<string, Promise<ThreadRunController>>();
  private readonly sessionDir: string;

  constructor(
    private readonly runStore: RunStore,
    private readonly options: PiExecutorOptions,
  ) {
    this.sessionDir = options.sessionDir ?? join(options.workspaceDir, '.sessions');
  }

  async execute(run: RunRecord): Promise<RunOutput> {
    const controller = await this.getController(run.threadKey);
    return controller.submit(run);
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
