# jagc

> **jagc** = **j**ust **a** **g**ood **c**lanker. Name is a joke; runtime is serious.

Self-hosted “life automation” runtime built on:
- **pi-coding-agent** as the agent backbone (sessions, compaction, context files, skills/prompts/extensions, packages, SDK/RPC).
- **DBOS Transact (TypeScript)** as the durable workflow engine (Postgres-backed workflows/queues/scheduling).

## Status

- **Pre-alpha.** Expect breaking changes.
- **Contracts we intend to stabilize early:**
  - Workspace layout + override rules (see **Workspace contract**)
  - Normalized event schema (see **Normalized events**)
- **Everything else is allowed to change** (HTTP/CLI surface, DB schema, workflow names).

### Deployment files are drafts

Everything under `deploy/` is a **draft**. It exists to communicate *intended* operational shape and to bootstrap iteration, not as a supported install method yet.

---

## Goals

Build a **thin core** that:
- Accepts events/messages (initially **CLI** + **Telegram**).
- Runs **TypeScript workflows** that can invoke **pi agents** (and spawn sub-agents / branches).
- Lets users extend/override behavior (system prompt, skills, extensions, packages, workflows) via a **separate “user config repo”** (git/GitHub), not by forking core.

## Non-goals

- A giant “connector platform” in core (Jira, etc. are packages).
- A required UI for plumbing.
- A single “skills solve everything” approach. Skills are one packaging format; workflows + extensions + CLIs are equally first-class.

---

## MVP (v0)

This is the first slice we should ship before expanding scope:

- Server:
  - HTTP health endpoint
  - Ingest a message event, run a workflow durably via DBOS, return a `run_id`
- CLI:
  - `jagc message "..."` sends an event and prints a JSON result
- Telegram (polling mode):
  - Receive personal chat messages
  - Per-conversation serialization (no concurrent agent runs for the same chat; each run may include multiple internal turns/tool calls)
  - Reply with the agent output

### Acceptance tests (behavior)

- `jagc message "ping" --json` returns a JSON response that includes:
  - `run_id`
  - `status` (`succeeded|failed|running`)
  - `output` (when succeeded)
- If two messages arrive for the same `conversation_key`, they are processed **sequentially**.
- Messages for different `conversation_key`s can be processed concurrently.

---

## What this is

A small server + adapters:

- **Core server**
  - Receives inbound messages/events (HTTP webhook, CLI calls, Telegram updates).
  - Dispatches to **DBOS workflows** (durable, retryable, schedulable).
  - Runs **pi agent sessions** as workflow steps (tool calling, context compaction, branching).

- **Process model (simplicity-first default)**
  - Everything runs in **one Node.js process** by default: HTTP ingress, Telegram ingest (polling/webhook), and DBOS workflow execution.
  - Concurrency comes from async I/O + DBOS scheduling.
  - We still guarantee **per-conversation serialization** where needed (see **Concurrency guarantees**).
  - **Polling mode assumes a single running instance** to avoid competing `getUpdates` consumers.

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

## Tooling (decisions)

- **Node.js:** 20.x LTS (minimum) — aligns with modern TS tooling.
- **Package manager:** `pnpm`
- **Language:** TypeScript (ESM; `type: "module"`)
- **Database:** Postgres (DBOS-backed durability)

JS/TS baseline (intent; we’ll pin versions once scaffolding starts):

- **TS execution (dev/CLI scripting):** `tsx`
- **Lint/format:** **Biome** (`@biomejs/biome`)
- **Multi-process dev (when needed):** `concurrently`
- **Git hooks (optional):** `husky`


---

## Repository layout (current + intended)

This repo is still being scaffolded. The default plan is a **single Node.js project** (no workspaces) with clear module boundaries.

### Repository map (high-level)

```text
/
├─ src/
│  ├─ server/                # HTTP ingress + DBOS workflow runner
│  ├─ cli/                   # JSON-first CLI entrypoints
│  ├─ runtime/               # Thin wrapper around pi SDK/RPC (`AgentRunner`)
│  ├─ adapters/              # Built-in adapters (telegram, cli, etc.)
│  ├─ workflows/             # Built-in workflows shipped with core
│  ├─ skills/                # Built-in skills shipped with core
│  └─ shared/                # Shared types/utilities/config
├─ configs/                  # Centralized config templates (env, db, etc.)
├─ scripts/                  # Dev/CI helper scripts
├─ docs/                     # Architecture notes, runbooks
├─ deploy/                   # Infra and deployment assets (draft)
├─ tests/                    # Tests (as needed)
├─ package.json              # Single-project root
└─ pnpm-lock.yaml            # pnpm lockfile (once we add deps)
```

### Code organization principles

- **Single project:** one Node.js app with clear module boundaries.
- **Thin core, but ships defaults:** core includes built-in adapters, workflows, and skills so the system is usable out of the box.
- **User config repo stays separate:** user workflows, skills, prompts, and tools live in user-land and can override built-ins.
- **Stable boundaries:** adapters depend on `runtime` + `shared`, not on each other.

### User config repo (workspace)

User config repo (separate git repo, **repo-root files** — no `.pi/` nesting):

- `SYSTEM.md`                user system prompt override
- `APPEND_SYSTEM.md`         optional additional system prompt content
- `skills/`                  Agent Skills standard
- `prompts/`                 prompt templates
- `extensions/`              custom tools, hooks, gates
- `themes/`                  optional
- `settings.json`            pi/jagc settings (optional)
- `git/` / `npm/`            project-local pi package installs (optional)
- `AGENTS.md`                user “policy + conventions” (loaded as context)
- `workflows/`               TypeScript workflows (loaded by the server)
- `tools/`                   scripts/CLIs the agent can run (optional)

The server is pointed at the user repo path as its “workspace”.


---

## Quick start (dev)

> This section documents the intended developer experience. Exact commands will be finalized as the repo is scaffolded.

### Prereqs

- Node.js (LTS)
- Postgres
- A pi-supported LLM provider credential (API key or provider setup)
- Telegram Bot token (optional, if running telegram adapter)

### Environment

All application config env vars are prefixed with **`JAGC_`**, except `PI_CODING_AGENT_DIR`.

Example:

- `JAGC_DATABASE_URL=postgres://...`
- `JAGC_WORKSPACE_DIR=/path/to/user-config-repo`
- `JAGC_PORT=31415`
- Provider keys (e.g. `OPENAI_API_KEY=...`, etc.)
- `PI_CODING_AGENT_DIR=/path/to/pi-agent-state` (optional)
- Telegram (optional)
  - `JAGC_TELEGRAM_BOT_TOKEN=...`
  - `JAGC_TELEGRAM_INGEST_MODE=polling|webhook` (default: `polling`)
  - (webhook) `JAGC_TELEGRAM_WEBHOOK_PATH=/telegram/webhook`
  - (webhook) `JAGC_TELEGRAM_WEBHOOK_SECRET=...` (recommended)

### Run

1) Start Postgres
2) Install deps
   - `pnpm install`
3) Start server
   - `pnpm dev`
4) Talk to it
   - CLI: `jagc message "..." --json`
   - Telegram: message the bot

---

## Configuration reference

### Required

- `JAGC_DATABASE_URL`
  - Postgres connection string.
- `JAGC_WORKSPACE_DIR`
  - Path to the user config repo (contains `workflows/`, `AGENTS.md`, and optional pi/jagc overrides such as `SYSTEM.md`, `skills/`, `extensions/`, etc.).
- `JAGC_PORT`
  - Server bind port.

### Optional

- `PI_CODING_AGENT_DIR`
  - Overrides pi-coding-agent’s config/state directory (default: `~/.pi/agent`).
  - This is where **sessions**, global `skills/`, `prompts/`, `extensions/`, `themes/`, and `settings.json` live.
  - **Must be persisted** (e.g. Docker volume) if you want sessions to survive restarts.

- Logging (recommended to implement early)
  - `JAGC_LOG_LEVEL=debug|info|warn|error` (default: `info`)
  - `JAGC_LOG_FORMAT=pretty|json` (default: `pretty` in dev, `json` in prod)

### Telegram

- `JAGC_TELEGRAM_BOT_TOKEN`
- `JAGC_TELEGRAM_INGEST_MODE=polling|webhook` (default: `polling`)
- `JAGC_TELEGRAM_WEBHOOK_PATH` (default: `/telegram/webhook`)
- `JAGC_TELEGRAM_WEBHOOK_SECRET` (optional; recommended)

### Provider credentials

LLM provider credentials are **passed through** to pi/provider SDKs; jagc does not interpret them. Example:
- `OPENAI_API_KEY=...`

---

## Workspace contract (JAGC_WORKSPACE_DIR)

The workspace is a **trusted** local directory (usually a git repo) that contains user overrides and automation logic.

### Minimal workspace

```text
$JAGC_WORKSPACE_DIR/
  workflows/
  AGENTS.md           (recommended)
  SYSTEM.md           (optional)
  APPEND_SYSTEM.md    (optional)
  skills/             (optional)
  prompts/            (optional)
  extensions/         (optional)
  themes/             (optional)
  settings.json       (optional)
```

### Override rules (intent)

- Core may ship built-in workflows such as `telegram.message`.
- If the workspace defines a workflow with the same name, the workspace version **wins**.

### System prompt overrides

Users can fully replace or append the system prompt from their workspace:
- `SYSTEM.md` (replace)
- `APPEND_SYSTEM.md` (append)

### Context rules (AGENTS.md)

Users define policies and conventions in `AGENTS.md` files. These are loaded into the agent context automatically (global + workspace + parent dirs).

---

## Interfaces

### CLI (non-interactive)

The CLI should be:
- scriptable (stdin/stdout)
- JSON-first (optional human formatting)
- able to:
  - send a message to the default workflow
  - start a named workflow with args
  - fetch status/results
  - tail logs (optional)

### HTTP API (v1, draft)

This is a **draft** API contract we should implement for the MVP.

- `GET /healthz`
  - Returns 200 when the process is up.
- `POST /v1/events`
  - Accepts a normalized event payload (see below)
  - Returns `{ run_id }`
- `GET /v1/runs/:run_id`
  - Returns status and (when complete) output

**Error shape (draft):**

```json
{ "error": { "code": "...", "message": "..." } }
```

### Normalized events

All ingresses (CLI, Telegram, webhooks) should normalize into a common event:

```json
{
  "schema_version": 1,
  "type": "telegram.message",
  "conversation_key": "...",
  "user_key": "...",
  "text": "...",
  "raw": {}
}
```

Notes:
- `schema_version` allows intentional evolution.
- `raw` is optional and should be treated carefully (may contain PII/secrets).

---

## Telegram (personal chats only, for now)

Telegram support is split into two pieces:
- **Ingest** (how updates arrive): long-polling or webhooks
- **Workflow** (what we do with a message): `telegram.message` workflow (user-overridable)

### Ingest modes

Both modes must normalize updates into the same internal event shape and call the same Telegram workflow.

- **Long polling (recommended default for self-hosters):** the server periodically calls `getUpdates` and processes updates.
  - easiest to run locally (no public URL required)
- **Webhook:** the server exposes an HTTP endpoint and configures the bot webhook.
  - better latency and lower idle load, but needs a public URL / tunnel

### Implementation (library)

We implement the Telegram adapter using [grammY](https://grammy.dev/) (`grammy`).

Recommended wiring:
- **Polling:** use `@grammyjs/runner` to run long polling reliably.
- **Webhook:** expose a webhook endpoint (default: `POST /telegram/webhook`) and mount grammY’s webhook callback in the HTTP server.

### Incoming message → workflow

For a personal message to the bot, the adapter triggers the workflow `telegram.message` with a normalized payload:
- `conversation_key: <telegram chat_id>`
- `user_key: <telegram from.id>`
- `text: <message text>`
- `raw: <raw telegram update>` (optional, for debugging)

The workflow should run the pi agent in its default **agent loop** (multiple internal turns/tool calls as needed) until it produces a final reply for Telegram.

### Conversation sessions

pi manages the **session contents** (on-disk JSON files). The runtime manages only the **routing**: which Telegram conversation maps to which pi `session_id`.

For personal chats we use **one agent session per Telegram `chat_id`**.

---

## Concurrency guarantees

We want high concurrency across *different* conversations, but we must process messages **sequentially per `conversation_key`** to avoid overlapping writes to the same pi session.

Guarantees (intent):
- For the same `conversation_key`: **strict serialization** (one agent run at a time; each run may span multiple internal turns/tool calls).
- For different `conversation_key`s: may execute concurrently.

Implementation strategy:
- Use **DBOS/Postgres-backed serialization**, not in-memory locks.
- Acquire a durable **per-conversation lock** (row-level lock or advisory lock keyed by `conversation_key`) inside a DBOS transaction before running an agent step.

---

## Persistence model

- Postgres stores:
  - DBOS workflow state (durability)
  - conversation/session routing metadata (e.g. `conversation_key -> session_id`)
  - (recommended) audit log of tool calls / external side effects

- Disk stores:
  - pi session state under `PI_CODING_AGENT_DIR` (or default `~/.pi/agent`)

**Backups:** to preserve conversations, back up **both** Postgres and `PI_CODING_AGENT_DIR`.

---

## Logging & observability (recommended defaults)

- Default to structured logs in production (`JAGC_LOG_FORMAT=json`).
- Include correlation fields in every log line:
  - `run_id`, `workflow_name`, `conversation_key` (when applicable)

---

## Self-extension (“agent can extend itself”)

Supported by design:
- the agent can write/update:
  - skills (`skills/…`)
  - prompt templates (`prompts/…`)
  - extensions/tools (`extensions/…`, `tools/…`)
  - workflow code (`workflows/…`)
- the server can optionally auto-commit changes in the user repo
  - recommended default: **only after explicit human approval**

---

## Packages (skills/prompts/extensions/themes)

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
Use `-l` to write to workspace-local settings (`settings.json` in the workspace root, per jagc convention) instead:

```bash
pi install -l npm:@foo/bar
```

> Security: Pi packages run with full system access. Review third-party packages before installing.

---

## Deployment (draft)

Draft assets exist under:
- `deploy/systemd/`
- `deploy/launchd/`

They currently assume conventions like:
- code in `/opt/jagc`
- workspace in `/var/lib/jagc/workspace`
- env file in `/etc/jagc/jagc.env`

These are **not stable** yet; treat them as examples.

---

## Security model

This system can run arbitrary code:
- extensions can execute arbitrary JS/TS
- tools can run arbitrary binaries
- installing third-party packages is powerful and dangerous

Trust boundaries (intent):
- The workspace is **trusted code** and executes with server permissions.
- Third-party pi packages are **trusted code**.

Recommended baseline:
- run as an unprivileged user
- keep secrets out of repos; inject via env/secret store
- add approval gates for risky actions (money, deletion, account changes)
- maintain an audit log of tool calls and external side effects

---

## Verifiability & testing (design contract)

Verifiability is a core product requirement, especially because the system will run AI agents that can change behavior over time. The rule of thumb:

- **If an integration can’t be triggered and observed via CLI, it’s not “real” yet.**

This implies:
- every ingress (CLI, HTTP, Telegram webhook/polling) has a **CLI equivalent** for simulation/replay
- the CLI can **wait for runs**, fetch results, and surface logs in a scriptable way
- we support **“real stack” local runs** (no mocks) and **deterministic CI runs** (mocks/fixtures)

### Integration test options

**Decision (default): we will implement Option A first** (black-box end-to-end via the CLI + a real running server). Options B/C remain valuable supplements once the core is stable.

#### Option A (default): Black-box end-to-end tests via the CLI + a real running server

- Start the whole stack (server + Postgres) and test it only through public interfaces:
  - HTTP (`/v1/events`, `/v1/runs/:id`)
  - CLI (`jagc …`)
  - Telegram ingress (simulated via CLI webhook sender)
- Best at catching wiring/config regressions.
- Works great for local verification and for running in CI with a mock/deterministic LLM provider.

**Dev UX target:** one command starts everything “for real”:

- `pnpm dev` — start the server in watch mode
- `pnpm dev:up` — start all dependencies (ex: Postgres) + run migrations + start server (exact scripting TBD)

Then verification is just:

- `jagc health`
- `jagc message "ping" --json`
- `jagc run wait <run_id> --timeout 60s --json`

**What the integration suite must cover (minimum):**
- health check (`/healthz`)
- event ingest (`POST /v1/events`) + run completion (`GET /v1/runs/:id`)
- webhook simulation path (post a fixture JSON to an adapter endpoint)
- per-conversation serialization (send two events with same `conversation_key` and assert ordered processing)

#### Option B: Integration tests in-process (Vitest) + ephemeral Postgres (Testcontainers)

- Run tests against a real Postgres, provisioned per test run.
- Call the HTTP server in-process (random port) and assert on responses.
- Faster feedback than full multi-process tests; excellent for CI.

Tradeoff: can miss some “real process” issues (env wiring, logging, signal handling) unless paired with Option A smoke tests.

#### Option C: Fixture/replay tests for adapters + normalized events

- Keep a small library of real-ish fixtures:
  - Telegram update JSON payloads
  - Webhook payloads from other providers
  - Normalized event JSON inputs
- CI replays fixtures through the same normalization + workflow dispatch path and snapshots outputs.

Tradeoff: fixtures drift if not curated; best used as a supplement to A/B.

### CLI capabilities required for verifiable testing

The CLI is part of the test harness. It must be able to drive the system the way external systems do.

**Command name:** `jagc`

**Global conventions (intent):**
- `--json` for machine output, human-friendly output by default
- stderr for logs/diagnostics, stdout for primary output
- `--no-input` disables prompts (required for CI)
- server target is configurable (flags beat env):
  - `--api-url http://127.0.0.1:31415` (default)
  - `JAGC_API_URL=http://127.0.0.1:31415`

#### Proposed command surface (minimal but complete)

- `jagc health`
  - checks HTTP health (`/healthz`) and exits non-zero if unhealthy

- `jagc event send`
  - sends a **normalized event** to `POST /v1/events`
  - supports `--type`, `--conversation-key`, `--user-key`, `--text`, and `--raw @file.json`

- `jagc message "…"`
  - convenience wrapper for `event send` targeting the default message workflow

- `jagc ask "…"`
  - alias for `jagc message` (deprecated; may be removed once the CLI surface stabilizes)

- `jagc run get <run_id>`
  - fetches status/output from `GET /v1/runs/:run_id`

- `jagc run wait <run_id>`
  - waits until completion (or timeout); useful for scripts and integration tests

- `jagc webhook send`
  - simulates third-party webhooks by posting JSON to the relevant endpoint
  - examples:
    - `jagc webhook send --path /telegram/webhook --body @tests/fixtures/telegram/update.json`
    - `jagc webhook send --path /telegram/webhook --header "X-Telegram-Bot-Api-Secret-Token: …" --body @…`

> Design note: we intentionally keep webhook simulation generic (`--path/--body/--header`) so we can test *any* adapter without adding a new command every time.

### Suggested repo scripts (for repeatable verification)

Planned script names (intent):
- `pnpm test` — unit + integration (mock provider)
- `pnpm test:integration` — black-box integration tests against a running server
- `pnpm test:e2e:real` — local-only smoke tests that hit a real LLM provider (requires credentials)
- `pnpm verify` — lint + typecheck + unit + integration

## Development

Planned repo scripts (names we should standardize on):
- `pnpm dev` — run server in watch mode
- `pnpm start` — production start (matches deploy drafts)
- `pnpm test` — unit + integration
- `pnpm lint`
- `pnpm typecheck`

---

## License

**UNLICENSED** for now (all rights reserved) until we add a `LICENSE` file.

---

## Upstream references used for design alignment (pi + DBOS)

- pi is designed as a minimal harness that is extended via **extensions, skills, prompt templates, themes**, and shared as **pi packages** installable from **npm or git**.
- pi loads **AGENTS.md** context files and supports **system prompt replacement** (jagc workspaces place this at `SYSTEM.md` + optional `APPEND_SYSTEM.md` at repo root).
- DBOS Transact is positioned as an open-source **durable execution/workflows** library (including TypeScript) backed by **Postgres**.
