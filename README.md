# my-kaiser

Self-hosted “life automation” runtime built on:
- **pi-coding-agent** as the agent backbone (sessions, compaction, context files, skills/prompts/extensions, packages, SDK/RPC).
- **DBOS Transact (TypeScript)** as the durable workflow engine (Postgres-backed workflows/queues/scheduling).

The goal is a **thin core** that:
- Accepts events/messages (initially **CLI** + **Telegram**).
- Runs **TypeScript workflows** that can invoke **pi agents** (and spawn sub-agents / branches).
- Lets users extend/override everything (system prompt, skills, extensions, packages, CLI tools) via a **separate “user config repo”** (git/GitHub), not by forking core.

---

## What this is

A small server + adapters:

- **Core server**
  - Receives inbound messages/events (HTTP webhook, CLI calls, Telegram updates).
  - Dispatches to **DBOS workflows** (durable, retryable, schedulable).
  - Runs **pi agent sessions** as workflow steps (tool calling, context compaction, branching).

- **Adapters (core interfaces)**
  - `cli`: non-interactive command interface (JSON in/out)
  - `telegram`: chat interface (bot)
  - Future: Slack/WhatsApp/web UI — **not in core** (implemented as additional adapters/packages).

- **User config repo (separate from core)**
  - Owns the user’s automation logic and preferences:
    - system prompt overrides
    - AGENTS.md context rules
    - pi packages (skills, prompt templates, extensions, themes)
    - additional tools (CLIs/scripts)
    - workflow code (TypeScript)

---

## Non-goals

- A giant “connector platform” in core (Jira, etc. are packages).
- A required UI for plumbing.
- A single “skills solve everything” approach. Skills are one packaging format; workflows + extensions + CLIs are equally first-class.

---

## Core ideas

### 1) Workflows are TypeScript (DBOS), not markdown
DBOS workflows orchestrate everything:
- triggers: webhook, cron, message events, internal events
- steps: call APIs, run tools, run agent, ask human approval, etc.
- durability: retries, crash recovery, idempotency patterns, scheduling

### 2) The agent is a step (or many steps)
Any workflow step can:
- start an agent run with specific context
- fork/branch into a sub-agent session for focused work
- resume previous sessions
- compact context automatically when long-running

### 3) “User-land” is a repo, not a fork
Users should be able to:
- override the system prompt
- add/replace skills, prompts, extensions, themes
- install pi packages from git/npm
- add their own tools (CLIs/scripts)
- let the agent extend itself by editing the user repo (and committing changes)

Core stays small and updateable; users keep their customizations in their own repo.

---

## Repository layout (suggested)

Core repo (this repo):
- `apps/server/`         DBOS app + HTTP ingress + workflow runner
- `apps/cli/`            CLI that talks to the server (JSON friendly)
- `packages/runtime/`    thin wrapper around pi SDK/RPC (“AgentRunner”)
- `packages/adapters/telegram/` Telegram adapter (optional package if you prefer)

User config repo (separate git repo):
- `.pi/`
  - `SYSTEM.md`                user system prompt override
  - `APPEND_SYSTEM.md`         optional additional system prompt content
  - `skills/`                  Agent Skills standard
  - `prompts/`                 prompt templates
  - `extensions/`              custom tools, hooks, gates, UI (optional)
  - `themes/`                  optional
  - `settings.json`            pi settings (optional)
  - `git/` / `npm/`            project-local pi package installs (optional)
- `AGENTS.md`                  user “policy + conventions” (loaded as context)
- `workflows/`                 TypeScript workflows (loaded by the server)
- `tools/`                     scripts/CLIs the agent can run (optional)

The server is pointed at the user repo path as its “workspace” / cwd.

---

## Quick start (dev)

### Prereqs
- Node.js (LTS)
- Postgres
- A pi-supported LLM provider credential (API key or provider setup)
- Telegram Bot token (optional, if running telegram adapter)

### Run
1) Start Postgres
2) Configure env (example)
   - `DATABASE_URL=postgres://...`
   - `WORKSPACE_DIR=/path/to/user-config-repo`
   - `PORT=...`
   - Provider keys (e.g. `OPENAI_API_KEY=...`, etc.)
   - `PI_CODING_AGENT_DIR=/path/to/pi-agent-state` (optional)
     - overrides pi-coding-agent’s config/state directory (default: `~/.pi/agent`)
     - this is where `settings.json`, **sessions**, and global `skills/`, `prompts/`, `extensions/`, `themes/` live
     - ensure this path is on persistent storage (e.g. Docker volume)
   - Telegram (optional)
     - `TELEGRAM_BOT_TOKEN=...`
     - `TELEGRAM_INGEST_MODE=polling|webhook` (default: `polling`)
     - (webhook) `TELEGRAM_WEBHOOK_PATH=/telegram/webhook`
     - (webhook) `TELEGRAM_WEBHOOK_SECRET=...` (recommended)

3) Start server
- `pnpm dev` (or similar; define the exact commands as you scaffold)

4) Talk to it
- CLI: `kaiser ask "..." --json`
- Telegram: message the bot

---

## Configuration & customization

### System prompt overrides
Users can fully replace or append the system prompt from their config repo:
- `.pi/SYSTEM.md` (replace)
- `.pi/APPEND_SYSTEM.md` (append)

### Context rules (AGENTS.md)
Users define policies and conventions in `AGENTS.md` files.
These are loaded into the agent context automatically (global + workspace + parent dirs).

### Packages (skills/prompts/extensions/themes)
Pi packages bundle extensions, skills, prompt templates, and themes and can be installed from **npm**, **git**, or a **local path**.

Install and manage packages with the `pi` CLI:

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install https://github.com/user/repo  # raw URLs work too
pi install /absolute/path/to/package

pi remove npm:@foo/bar
pi list
pi update
```

**Scope:** by default, `pi install/remove` write to global settings (`~/.pi/agent/settings.json`, or `PI_CODING_AGENT_DIR/settings.json` if set).
Use `-l` to write to project settings (`.pi/settings.json`) instead:

```bash
pi install -l npm:@foo/bar
```

Project settings are the recommended way to share a reproducible setup in a user config repo: pi will install any missing packages automatically.

The core server should:
- load built-in packages (shipped with core) by default
- load user-installed packages from the workspace/global pi directories
- support a “reload” action to pick up changes without restarting

> **Security:** Pi packages run with full system access. Review third-party packages before installing.

### Dynamic context injection (recommended pattern)
Use a pi extension hook to inject *dynamic* context into the system prompt at agent start:
- current date/time
- cwd/workspace
- loaded skills list
- loaded AGENTS.md content
- references to local docs/resources

This keeps the core thin while allowing deep customization in user-land.

---

## Interfaces (core)

### CLI (non-interactive)
The CLI should be:
- scriptable (stdin/stdout)
- JSON-first (optional human formatting)
- able to:
  - send a message to the default agent/workflow
  - start a named workflow with args
  - fetch status/results
  - tail logs (optional)

### Telegram (personal chats only, for now)
Telegram support is split into two pieces:
- **Ingest** (how updates arrive): long-polling or webhooks
- **Workflow** (what we do with a message): a built-in `telegram.message` workflow (user-overridable)

#### Ingest modes
Both modes must normalize updates into the same internal event shape and call the same Telegram workflow. Ingest mode does not change conversation/session semantics.

- **Long polling (recommended default for self-hosters):** the server periodically calls `getUpdates` and processes updates.
  - easiest to run locally (no public URL required)
- **Webhook:** the server exposes an HTTP endpoint and configures the bot webhook.
  - better latency and lower idle load, but needs a public URL / tunnel

#### Implementation (library)
We implement the Telegram adapter using [grammY](https://grammy.dev/) (`grammy`).

Recommended wiring:
- **Polling:** use `@grammyjs/runner` to run long polling reliably.
- **Webhook:** expose a webhook endpoint (default: `POST /telegram/webhook`) and mount grammY’s webhook callback in the HTTP server.

Suggested env (in addition to `TELEGRAM_BOT_TOKEN`):
- `TELEGRAM_INGEST_MODE=polling|webhook` (default: `polling`)
- `TELEGRAM_WEBHOOK_PATH=/telegram/webhook` (webhook mode)
- `TELEGRAM_WEBHOOK_SECRET=...` (optional; recommended for spoofing protection)

#### Incoming message → workflow
For a personal message to the bot, the adapter triggers the built-in workflow `telegram.message` with a normalized payload:
- `conversation_key: <telegram chat_id>`
- `user_key: <telegram from.id>`
- `text: <message text>`
- `raw: <raw telegram update>` (optional, for debugging)

#### Conversation sessions
pi manages the **session contents** (on-disk JSON files). The runtime manages only the **routing**: which Telegram conversation maps to which pi `session_id`.

For personal chats we use **one agent session per Telegram `chat_id`**.

The built-in `telegram.message` workflow is intentionally boring:
1) **Command routing**
   - `/start`, `/help`
   - `/reload` (reload workspace packages/extensions)
   - `/new` resets the conversation by clearing the `session_id` mapping for this `conversation_key`
2) **Resolve session**
   - look up `conversation_key -> session_id` in Postgres
   - if missing/null: create a new pi session and upsert the mapping
3) **Run agent**
   - start/resume pi with `session_id` and pass the message text
   - send the agent response back to Telegram

**Operational note:** pi session state lives on disk under the pi config directory (default `~/.pi/agent`, override via `PI_CODING_AGENT_DIR`). Ensure this directory is on persistent storage (e.g. a Docker volume) so sessions survive restarts.

---

## Workflows

Workflows live in user-land (`workflows/`) and are loaded by the server.

Core may ship a small set of **adapter-scoped** built-in workflows (e.g. `telegram.message`, `whatsapp.message`, `slack.message`). If the user repo defines a workflow with the same name, it overrides the built-in one.

Guidelines:
- keep workflows small and composable
- treat “agent calls” as steps with explicit inputs/outputs
- build approval gates as steps (especially for destructive actions)
- write tools as CLIs when possible; wrap them as agent tools via extensions

Example (conceptual):
- Trigger: “new Telegram message”
- Workflow:
  1) normalize input + route (what intent?)
  2) agent step: decide plan + which tools/packages to use
  3) tool steps: call APIs, run browser automation, run CLIs
  4) agent step: summarize + propose next actions
  5) (optional) commit changes to user repo (self-extension)

---

## Self-extension (“agent can extend itself”)

Supported by design:
- the agent can write/update:
  - skills (`.pi/skills/…`)
  - prompt templates (`.pi/prompts/…`)
  - extensions/tools (`.pi/extensions/…`, `tools/…`)
  - workflow code (`workflows/…`)
- the server can optionally auto-commit changes in the user repo
  - (you decide: always, never, or only after human approval)

---

## Security notes

This system can run arbitrary code:
- extensions can execute arbitrary JS/TS
- tools can run arbitrary binaries
- installing third-party packages is powerful and dangerous

Recommended baseline:
- run in a container or restricted user
- add approval gates for risky actions (money, deletion, account changes)
- keep secrets out of the repo; inject via env/secret store
- maintain an audit log of tool calls and external side effects

---

## Roadmap (non-core)
- Slack / WhatsApp adapters
- Optional web UI (thin wrapper over the same server API)
- Connector packages (GitHub/Jira/etc.) as installable packages, not core
- Optional “marketplace” / curated package registry

---

**Upstream references used for design alignment (pi + DBOS):**

* pi is designed as a minimal harness that is extended via **extensions, skills, prompt templates, themes**, and shared as **pi packages** installable from **npm or git**; it also supports **interactive, print/JSON, RPC, and SDK** modes. ([GitHub][1])
* pi loads **AGENTS.md** context files and supports **system prompt replacement** via `.pi/SYSTEM.md` or `~/.pi/agent/SYSTEM.md`, plus appending via `APPEND_SYSTEM.md`. ([GitHub][1])
* pi extensions can register tools/commands and hook events; pi packages run with full system access and should be reviewed before installing. ([GitHub][1])
* Example of dynamic prompt/context injection via an extension hook (modifying the system prompt in `before_agent_start`, loading AGENTS.md + skills, etc.). ([GitHub][2])
* DBOS Transact is positioned as an open-source **durable execution/workflows** library (including TypeScript) backed by **Postgres**, providing primitives like durable queues/scheduling/event processing. ([DBOS][3])

[1]: https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/coding-agent/README.md "raw.githubusercontent.com"
[2]: https://raw.githubusercontent.com/default-anton/dotfiles/refs/heads/master/pi/agent/extensions/inject-context.impl.mjs "raw.githubusercontent.com"
[3]: https://www.dbos.dev/dbos-transact "DBOS Transact | Open Source Durable Execution Library"
