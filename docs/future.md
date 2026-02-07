# jagc (future + deferred details)

> Moved from `README.md` to keep the root README MVP-focused. Content below is preserved draft design and roadmap material.
>
> For current implementation architecture, see [`docs/architecture.md`](./architecture.md).

> **jagc** = **j**ust **a** **g**ood **c**lanker.

Self-hosted AI assistant to automate your life:
- **pi-coding-agent** (from [`pi-mono`](https://github.com/badlogic/pi-mono), package: [`packages/coding-agent`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)) as the agent backbone (sessions, compaction, context files, skills/prompts/extensions, packages, SDK/RPC).
- **DBOS Transact (TypeScript)** as the durable workflow engine (Postgres-backed workflows/queues/scheduling).

## Status

- **Pre-alpha.** Expect breaking changes.
- Current vertical slice ships: `/healthz`, `/v1/messages`, `/v1/runs/:run_id`, CLI `message` + `run wait`, DBOS-backed durable scheduling/recovery, and persisted `thread_key -> session` mapping.
- **Contracts we intend to stabilize early:**
  - Workspace layout + override rules (see **Workspace contract**)
  - Ingress envelope + idempotency semantics (internal), and thread/run behavior (see **Ingress envelope (internal)** and **Threads, runs, and queued messages**)
- **Everything else is allowed to change** (HTTP/CLI surface, DB schema, workflow names).

### Deployment files are drafts

Everything under `deploy/` is a **draft**. It exists to communicate *intended* operational shape and to bootstrap iteration, not as a supported install method yet.

---

## Goals

Build a **thin core** that:
- Accepts **messages** from multiple ingresses (initially **CLI** + **Telegram**; webhooks as a specific ingress type).
- Runs **TypeScript workflows** that can invoke **pi agents** (and spawn sub-agents / branches).
- Lets users extend/override behavior via a **separate “user config repo”** (git/GitHub), not by forking core, using **pi concepts** (skills, prompt templates, extensions, themes, packages) plus jagc workflows.

## Non-goals

- A giant “connector platform” in core (Jira, etc. are packages).
- A required UI for plumbing.
- A single “skills solve everything” approach. Skills are one packaging format; workflows + extensions + CLIs are equally first-class.

---

## MVP (v0)

This is the first slice we should ship before expanding scope:

- Server:
  - HTTP health endpoint
  - Ingest a message, run a workflow durably via DBOS, return a `run_id`
- CLI:
  - `jagc message "..."` sends a message and prints a JSON result
- Telegram (polling mode):
  - Receive personal chat messages
  - One active run per Telegram thread (chat), with queued input behavior matching pi (`steer` and `followUp`)
  - Reply with the agent output

### Acceptance tests (behavior)

- `jagc message "ping" --json` returns a JSON response that includes:
  - `run_id`
  - `status` (`succeeded|failed|running`)
  - `output` (when succeeded)
  - `error.message` (when failed)
- If two messages arrive for the same thread while a run is active, delivery obeys mode (`steer` interrupts after current tool; `followUp` queues for after completion).
- Different threads can execute concurrently.

---

## What this is

A small server + adapters:

- **Core server**
  - Receives inbound messages from adapters (CLI calls, Telegram updates, webhooks).
  - Dispatches to **DBOS workflows** (durable, retryable, schedulable).
  - Runs **pi agent sessions** as workflow steps (tool calling, context compaction, branching).

- **Process model (simplicity-first default)**
  - Everything runs in **one Node.js process** by default: HTTP ingress, Telegram ingest (polling/webhook), and DBOS workflow execution.
  - Concurrency comes from async I/O + DBOS scheduling.
  - We still guarantee **per-thread run isolation** where needed (see **Concurrency guarantees**).
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

## Tooling (locked v0 stack)

Source of truth: **[`AGENTS.md`](../AGENTS.md)**.

- Runtime: TypeScript (ESM) on Node.js 20 + `pnpm`
- Durable execution + DB: DBOS Transact + Postgres
- HTTP server: Fastify
- CLI: Commander
- Validation: Zod
- Logging: Pino (`pretty` dev, `json` prod)
- Telegram adapter: grammY (polling first)
- Lint/format: Biome
- Tests: Vitest
- Build: `tsdown`
- Dev TS runner/scripts: `tsx`

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

The server is pointed at a user repo path as its workspace (`JAGC_WORKSPACE_DIR`).

Canonical workspace layout, override rules, and config-file semantics live in **Workspace contract** below.

---

## Quick start (dev)

> This section documents the intended developer experience. Exact commands will be finalized as the repo is scaffolded.

### Prereqs

- Node.js 20.x LTS (minimum)
- Postgres
- A pi-supported LLM provider credential (API key or provider setup)
- Telegram Bot token (optional, if running telegram adapter)

### Environment

All jagc env vars are prefixed with **`JAGC_`**.
Use the canonical config table below as the single source of truth.

### Run

1) Start Postgres
2) Install deps
   - `pnpm install`
3) Set required env vars from the table below
4) Start server
   - `pnpm dev`
5) Talk to it
   - CLI: `jagc message "..." --json`
   - Telegram: message the bot

---

## Configuration reference (canonical env table)

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `JAGC_DATABASE_URL` | Yes | — | Postgres connection string. |
| `JAGC_WORKSPACE_DIR` | No | `~/.jagc` | Workspace + pi config/state dir (`workflows/`, `AGENTS.md`, `settings.json`, `auth.json`, `skills/`, `prompts/`, `extensions/`, `themes/`, sessions). On first run, jagc can copy `~/.pi/agent/{settings.json,auth.json}` when destination files are missing. |
| `JAGC_PORT` | Yes | `31415` | Server bind port. |
| `JAGC_API_URL` | No | `http://127.0.0.1:31415` | CLI target API URL (used by `jagc` commands; flag `--api-url` wins). |
| `JAGC_LOG_LEVEL` | No | `info` | Logging level (`debug|info|warn|error`). |
| `JAGC_LOG_FORMAT` | No | `pretty` (dev), `json` (prod) | Log output format. |
| `JAGC_TELEGRAM_BOT_TOKEN` | No | — | Required only when Telegram adapter is enabled. |
| `JAGC_TELEGRAM_INGEST_MODE` | No | `polling` | Telegram ingest mode (`polling|webhook`). |
| `JAGC_TELEGRAM_WEBHOOK_PATH` | No | `/telegram/webhook` | Telegram webhook route (webhook mode only). |
| `JAGC_TELEGRAM_WEBHOOK_SECRET` | No | — | Telegram webhook secret token (required for Telegram webhook mode). |
| `JAGC_WEBHOOK_BEARER_TOKEN` | No | — | Shared bearer token required by generic ingress `POST /v1/webhooks/:source` when enabled. |
| Provider credentials (for example `OPENAI_API_KEY`) | Depends | — | Passed through to pi/provider SDKs; jagc does not interpret provider-specific keys. |

Config precedence (intent): CLI flags > env vars > `$JAGC_WORKSPACE_DIR/jagc.json` > built-in defaults.

---

## Workspace contract (JAGC_WORKSPACE_DIR)

The workspace is a **trusted** local directory (usually a git repo) that contains user overrides and automation logic (repo-root files/directories; no `.pi/` nesting).

### Canonical workspace layout

```text
$JAGC_WORKSPACE_DIR/
  workflows/          # required: TypeScript workflows loaded by the server
  AGENTS.md           # recommended: policy + conventions loaded as context
  SYSTEM.md           # optional: replace system prompt
  APPEND_SYSTEM.md    # optional: append to system prompt
  skills/             # optional: Agent Skills artifacts
  prompts/            # optional: prompt templates
  extensions/         # optional: custom tools/hooks/gates
  themes/             # optional: themes
  tools/              # optional: scripts/CLIs the agent can run
  jagc.json           # optional: jagc workspace config
  settings.json       # optional: pi workspace-local settings
```

### Override rules (intent)

- Core may ship built-in workflows such as `telegram.message`.
- If the workspace defines a workflow with the same name, the workspace version **wins**.
- For **pi artifacts** (skills, prompt templates, extensions, themes), jagc relies on pi’s model; jagc does not define a separate extension system.
- In practice, if a workspace artifact has the same logical name as a built-in one, the workspace artifact **wins**.

### Workspace config files

- `jagc.json`
  - jagc-specific workspace config (non-secrets).
  - Recommended for runtime/workflow defaults that should live with the workspace repo.
- `settings.json`
  - pi workspace-local settings file (used by `pi install -l`, package declarations, etc.).
  - This remains a pi file; jagc should not repurpose it.

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
- `POST /v1/messages`
  - Primary ingest API for first-class user/system messages.
  - Accepts message payload (source + thread identity + text/payload + delivery mode).
  - Supports idempotent ingest via `idempotency_key` in payload (or `Idempotency-Key` header).
  - Returns `{ run_id }` (for duplicate idempotent submits, returns the existing `run_id`).
- `POST /v1/webhooks/:source`
  - Raw webhook ingest endpoint for third-party callback payloads.
  - Requires bearer-token auth via `Authorization: Bearer <token>` (v0 baseline).
  - Normalizes to internal ingress envelope, then dispatches workflow.
- `GET /v1/runs/:run_id`
  - Returns status and (when complete) output.

**Error shape (draft):**

```json
{ "error": { "code": "...", "message": "..." } }
```

### Webhook authentication policy

v0 baseline:
- Local CLI usage does not require auth.
- Generic `POST /v1/webhooks/:source` requires `Authorization: Bearer <token>`.
- Telegram webhook mode requires `X-Telegram-Bot-Api-Secret-Token` verification.

Post-v0 hardening path:
- Add HMAC request signing per source (for providers that support signatures).
- Enforce replay protection with timestamp + nonce windows.

### Ingress envelope (internal)

Internally, all ingresses normalize into one envelope for routing/idempotency/observability.
This is an implementation detail; users should think in terms of **messages** and **webhooks**, not “events everywhere”.

```json
{
  "schema_version": 1,
  "ingress_id": "ing_123",
  "source": "telegram",
  "received_at": "2026-02-05T12:34:56.000Z",
  "kind": "message",
  "thread_key": "telegram:chat:123456",
  "user_key": "telegram:user:999",
  "delivery_mode": "steer",
  "text": "...",
  "raw": {}
}
```

Notes:
- `schema_version` allows intentional evolution.
- `ingress_id` is used for idempotent ingest/deduplication.
- `thread_key` is the concurrency/routing key (not globally shared across channels by default).
- `delivery_mode` applies when a run is active (`steer` / `followUp`; see below).
- `raw` is optional and should be treated carefully (may contain PII/secrets).

---

## Threads, runs, and queued messages

This section is the core behavior contract for multi-ingress conversations.

### Terminology

- **Ingress**: where input came from (`telegram`, `cli`, `webhook`, future `whatsapp`, etc.).
- **Thread**: a channel-scoped conversation identity used for session routing + concurrency (e.g. `telegram:chat:<chat_id>`).
- **Run**: one active agent loop for a thread.

### Delivery behavior while a run is active (pi-aligned)

Behavior is intentionally aligned with pi SDK/RPC semantics:

- **`steer`**:
  - Message is queued and delivered after the current tool execution boundary.
  - Remaining planned tool calls from the current run are skipped.
  - Use this to interrupt and redirect in-flight work.
- **`followUp`**:
  - Message is queued and delivered only after the current run reaches idle.
  - Use this to append work without interrupting the current task.

Defaults (intent): `one-at-a-time` delivery for both steer and follow-up queues, matching pi defaults (`steeringMode` / `followUpMode`).

### Cross-channel isolation (default)

Sessions are isolated by thread identity, not by user identity alone.

- Telegram chat and WhatsApp chat from the same human are **different threads** by default.
- Telegram message while a webhook-triggered run is active does **not** join that webhook run unless explicitly linked.
- Cross-channel thread linking is a future explicit feature, not implicit behavior.

### Webhook thread policy (default)

Webhook runs use their own thread namespace and are independent from chat channels.

- Preferred key: `thread_key = webhook:<source>:<external_thread_id>` when the source payload has a stable external thread/job identifier.
- Fallback key: `thread_key = webhook:<source>:<ingress_id>` (ephemeral one-shot thread).
- Webhook runs are not merged into Telegram/WhatsApp threads unless an explicit linking workflow chooses to do that.

---

## Telegram (personal chats only, for now)

Telegram support is split into two pieces:
- **Ingest** (how updates arrive): long-polling or webhooks
- **Workflow** (what we do with a message): `telegram.message` workflow (user-overridable)

### Ingest modes

Both modes must normalize updates into the same internal ingress envelope and call the same Telegram workflow.

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

For a personal message to the bot, the adapter triggers workflow `telegram.message` with normalized routing fields:
- `thread_key: telegram:chat:<chat_id>`
- `user_key: telegram:user:<from.id>`
- `text: <message text>`
- `delivery_mode`: default for Telegram input while active run is `followUp` (`steer` explicit opt-in)
- `raw: <raw telegram update>` (optional, for debugging)

The workflow runs the pi agent loop. If a run is already active on the same thread, the message is queued according to `delivery_mode` (`steer` or `followUp`) instead of spawning a parallel run.

### Conversation sessions

pi manages the **session contents** (on-disk JSON files). The runtime manages only **routing**: which jagc `thread_key` maps to which pi `session_id`.

For personal Telegram chats we use **one agent session per `thread_key = telegram:chat:<chat_id>`**.

---

## Concurrency guarantees

We want high concurrency across different threads, while preventing overlapping writes to the same pi session.

Guarantees (intent):
- For the same `thread_key`: **at most one active run**.
- New input on that thread while active run exists is queued by delivery mode:
  - `steer`: deliver at next interruption point (after current tool), skipping remaining planned tools.
  - `followUp`: deliver after the run reaches idle.
- For different `thread_key`s: runs may execute concurrently.

Implementation strategy:
- Use **DBOS/Postgres-backed coordination**, not in-memory locks.
- Acquire a durable **per-thread lock** (row-level lock or advisory lock keyed by `thread_key`) for run state transitions and queue draining.

---

## Persistence model

- Postgres stores:
  - DBOS workflow state (durability)
  - thread/session routing metadata (e.g. `thread_key -> session_id`)
  - (recommended) audit log of tool calls / external side effects

- Disk stores:
  - pi session state under `JAGC_WORKSPACE_DIR` (default `~/.jagc`)

---

## Logging & observability (recommended defaults)

- Default to structured logs in production (JSON format).
- Include correlation fields in every log line:
  - `run_id`, `workflow_name`, `thread_key`, `source` (when applicable)

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

`extensions`, `skills`, `prompt templates`, `themes`, and `packages` are **pi concepts**. jagc uses pi’s extension model directly; jagc does not define a separate package/extension system.

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

**Scope:** by default, `pi install/remove` write to workspace settings under `JAGC_WORKSPACE_DIR/settings.json` (default `~/.jagc/settings.json`).
Use `-l` to write to workspace-local settings (`settings.json` in the workspace root, per pi convention) instead:

```bash
pi install -l npm:@foo/bar
```

Override behavior (intent): jagc may ship built-in pi artifacts for a good default UX; workspace-local artifacts with the same logical name override those built-ins.

> Security: Pi packages run with full system access. Review third-party packages before installing.

---

## Deployment (draft)

v0 canonical target is **single-host macOS** using `.env` configuration and launchd-style process management.

Draft assets exist under:
- `deploy/launchd/` (v0-first direction)
- `deploy/systemd/` (kept as draft for later Linux target support)

Operational default: prefer **explicit/manual restarts** after workspace changes.
`deploy/systemd/jagc.path` is experimental/opt-in and intentionally scoped to workflow code changes only.

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

### Integration testing approach (default)

We use **black-box end-to-end tests via the CLI + a real running server**.

- Start the whole stack (server + Postgres) and test it only through public interfaces:
  - HTTP (`/v1/messages`, `/v1/runs/:id`, webhook endpoints)
  - CLI (`jagc …`)
  - Telegram ingress (simulated via CLI webhook sender)
- This catches wiring/config regressions and matches real operator workflows.
- Works for local verification and CI (with a mock/deterministic LLM provider).

**Dev UX target:** one command starts everything “for real”:

- `pnpm dev` — start the server in watch mode
- `pnpm dev:up` — start all dependencies (ex: Postgres) + run migrations + start server (exact scripting TBD)

Then verification is just:

- `jagc health`
- `jagc message "ping" --json`
- `jagc run wait <run_id> --timeout 60s --json`

**What the integration suite must cover (minimum):**
- health check (`/healthz`)
- message ingest (`POST /v1/messages`) + run completion (`GET /v1/runs/:id`)
- webhook simulation path (post a fixture JSON to an adapter endpoint)
- per-thread run behavior:
  - same thread + `steer` interrupts correctly
  - same thread + `followUp` queues until idle
  - different threads can run concurrently

### CLI capabilities required for verifiable testing

The CLI is part of the test harness. It must be able to drive the system the way external systems do.

**Command name:** `jagc`

**Global conventions (intent):**
- `--json` for machine output, human-friendly output by default
- stderr for logs/diagnostics, stdout for primary output
- `--no-input` disables prompts (required for CI)
- server target is configurable (flags beat env):
  - `--api-url <url>`
  - `JAGC_API_URL=<url>` (see Configuration reference table for default)

#### Proposed command surface (minimal but complete)

- `jagc health`
  - checks HTTP health (`/healthz`) and exits non-zero if unhealthy

- `jagc message send`
  - sends a message to `POST /v1/messages`
  - supports `--idempotency-key`, `--source`, `--thread-key`, `--user-key`, `--text`, `--delivery-mode`, and `--raw @file.json`

- `jagc message "…"`
  - convenience wrapper for `message send` targeting the default message workflow

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

## Post-MVP priorities (P1)

Immediately after MVP, we should add:
- `jagc doctor`
  - validates environment, DB connectivity, workspace structure, and version compatibility
- `jagc workspace init`
  - scaffolds a canonical workspace (repo-root layout, sample workflow, minimal defaults)
- Structured observability baseline
  - JSON logs + core counters (run latency, queue depth, lock wait time, failure classes)

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

- pi upstream monorepo: [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono)
- pi coding agent package in that monorepo: [`packages/coding-agent`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- pi is designed as a minimal harness that is extended via **extensions, skills, prompt templates, themes**, and shared as **pi packages** installable from **npm or git**.
- pi loads **AGENTS.md** context files and supports **system prompt replacement** (jagc workspaces place this at `SYSTEM.md` + optional `APPEND_SYSTEM.md` at repo root).
- pi queue semantics for in-flight input are explicit in SDK/RPC/docs (`steer` interrupts at the next tool boundary; `followUp` waits for idle), and jagc thread behavior aligns with that contract.
- DBOS Transact is positioned as an open-source **durable execution/workflows** library (including TypeScript) backed by **Postgres**.
