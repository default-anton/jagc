# jagc

> **jagc** = **j**ust **a** **g**ood **c**lanker.

Self-hosted AI assistant to automate your life:
- **pi-coding-agent** for agent runtime behavior (sessions, context files, skills/prompts/extensions/themes/packages)
- **DBOS Transact (TypeScript)** for durable workflow execution (Postgres-backed)

This README is intentionally short and MVP-focused.

For current implemented architecture, see **[`docs/architecture.md`](docs/architecture.md)**.
For deferred APIs, deployment notes, and post-MVP plans, see **[`docs/future.md`](docs/future.md)**.

## Status

- **Pre-alpha.** Expect breaking changes.
- Core server endpoints are in place: `/healthz`, `/v1/messages`, `/v1/runs/:run_id`, auth catalog/login endpoints (`/v1/auth/providers`, `/v1/auth/providers/:provider/login`, `/v1/auth/logins/:attempt_id{,/input,/cancel}`), `/v1/models`, and thread runtime controls (`/v1/threads/:thread_key/{runtime,model,thinking}`).
- CLI supports the happy path plus runtime controls: `message`, `run wait`, `health`, `auth providers`, `auth login`, `model list/get/set`, and `thinking get/set`.
- Default executor runs through pi SDK sessions with DBOS-backed durable run scheduling/recovery.
- Same-thread queued follow-ups/steers are accepted and run completion is attributed via pi session events (not prompt promise timing).
- Strict global one-active-run-per-thread is enforced via DBOS partitioned queueing keyed by `thread_key`.
- Telegram polling adapter is implemented (personal chats), including button-based runtime controls via `/settings`, `/model`, `/thinking`, and `/auth`.
- `JAGC_RUNNER=echo` is available for deterministic smoke tests.
- **Deployment assets under `deploy/` are drafts** (not a supported install path yet).

## Locked v0 technology stack

Source of truth: **[`AGENTS.md`](AGENTS.md)**.

- Runtime: TypeScript (ESM) on Node.js 20 + pnpm
- Server/API: Fastify + Zod + Pino
- CLI: Commander
- Agent/runtime: pi-coding-agent
- Durable execution: DBOS Transact + Postgres
- Telegram: grammY (polling first)
- Quality/tooling: Biome + Vitest
- Build: tsdown

## MVP (v0)

Ship this first:

- Server:
  - `GET /healthz`
  - `POST /v1/messages` (ingest message, start durable run, return `run_id`)
  - `GET /v1/runs/:run_id` (status/output)
- CLI:
  - `jagc message "..." --json`
  - `jagc run wait <run_id> --json`
- Telegram:
  - **Polling mode only** for MVP
  - Personal chats only
  - One active run per Telegram thread (`thread_key = telegram:chat:<chat_id>`)
  - Queued input behavior aligned with pi semantics (`steer` / `followUp`)

### MVP acceptance behavior

- `jagc message "ping" --json` returns JSON including:
  - `run_id`
  - `status` (`succeeded|failed|running`)
  - `output` (when succeeded)
  - `error.message` (when failed)
- If two messages arrive for the same thread while a run is active:
  - `steer` interrupts at the next tool boundary
  - `followUp` waits for idle
- Different threads run concurrently.

## Contracts to stabilize early

We intentionally lock only these early:

1. **Workspace contract** (`JAGC_WORKSPACE_DIR`) and override rules
2. **Ingress envelope + idempotency semantics** (internal)
3. **Thread/run concurrency + queued message behavior** (`steer` / `followUp`)

Everything else remains flexible during pre-alpha.

## Minimal workspace contract

`JAGC_WORKSPACE_DIR` points to a trusted local repo.

Canonical layout (MVP):

```text
$JAGC_WORKSPACE_DIR/
  workflows/          # required
  AGENTS.md           # recommended
  SYSTEM.md           # optional
  APPEND_SYSTEM.md    # optional
  skills/             # optional
  prompts/            # optional
  extensions/         # optional
  themes/             # optional
  tools/              # optional
  jagc.json           # optional
  settings.json       # optional (pi workspace settings)
```

## Configuration (MVP minimum)

| Variable | Required | Notes |
| --- | --- | --- |
| `JAGC_DATABASE_URL` | Yes | Postgres connection string |
| `JAGC_WORKSPACE_DIR` | No | Workspace + pi agent directory (default `~/.jagc`) |
| `JAGC_HOST` | No | Server bind host (default `127.0.0.1`) |
| `JAGC_PORT` | No | Server bind port (default `31415`) |
| `JAGC_API_URL` | No | CLI API target (default `http://127.0.0.1:31415`) |
| `JAGC_RUNNER` | No | `pi` (default) or `echo` for deterministic local/smoke runs |
| `JAGC_TELEGRAM_BOT_TOKEN` | No | Required only when Telegram adapter is enabled |
| `JAGC_TELEGRAM_WEBHOOK_SECRET` | No | Required when Telegram webhook mode is enabled |
| `JAGC_WEBHOOK_BEARER_TOKEN` | No | Required when generic `POST /v1/webhooks/:source` ingress is enabled |

Auth setup and provider credential details: [`docs/auth.md`](docs/auth.md).

By default jagc uses `JAGC_WORKSPACE_DIR=~/.jagc` for both workspace files and pi resources. It creates the directory if needed, but does not copy `~/.pi/agent/{settings.json,auth.json}` automatically.

## Quick start (dev, intended)

1. `mise install` (rerun when required tools are missing or `.tool-versions` changes)
2. Start Postgres (`pnpm db:start && pnpm db:createdb`)
3. `pnpm install`
4. Set required env vars (see `.env.example`)
5. `pnpm dev` (applies SQL migrations from `migrations/` on startup)
6. Verify:
   - `pnpm smoke`
   - `pnpm test` (runs against real Postgres and creates worker-specific test databases on demand)
   - optional cleanup: `pnpm db:drop:test`
   - or manually: `pnpm dev:cli health --json` then `pnpm dev:cli message "ping" --json`
   - inspect provider/model catalog: `pnpm dev:cli model list --json`
   - inspect auth status / start OAuth login: `pnpm dev:cli auth providers --json` and `pnpm dev:cli auth login openai-codex`
   - inspect thread runtime controls: `pnpm dev:cli model get --thread-key cli:default --json` and `pnpm dev:cli thinking get --thread-key cli:default --json`

### CLI runtime controls (v0)

```bash
# provider/model catalog
jagc model list --json

# read current thread model + thinking
jagc model get --thread-key cli:default --json
jagc thinking get --thread-key cli:default --json

# set model + thinking for a thread
jagc model set openai/gpt-5 --thread-key cli:default --json
jagc thinking set medium --thread-key cli:default --json

# OAuth login via jagc broker
jagc auth providers --json
jagc auth login openai-codex
# optional: stable owner key to resume the same login flow
jagc auth login openai-codex --owner-key cli:default
```

## Security baseline

- Workspace code is **trusted** and runs with server permissions.
- Third-party pi packages are **trusted code**; review before installing.
- Local CLI usage requires no auth for v0.
- Generic webhook ingress (`POST /v1/webhooks/:source`) requires bearer-token auth (`Authorization: Bearer ...`).
- Telegram webhook mode requires `X-Telegram-Bot-Api-Secret-Token` verification.
- Hardening path after v0: add HMAC-signed payload verification + replay protection (timestamp/nonce window).
- Run as unprivileged user; keep secrets out of repos.

## License

**UNLICENSED** for now (all rights reserved) until a `LICENSE` file is added.

---

## Full design notes and deferred scope

All previously documented detailed content is preserved in **[`docs/future.md`](docs/future.md)**, including:
- expanded architecture drafts
- full CLI/API draft surface
- Telegram webhook mode details
- deployment drafts and runbooks
- observability and testing expansion plans
- post-MVP roadmap
