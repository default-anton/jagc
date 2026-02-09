# jagc

> **jagc** = **j**ust **a** **g**ood **c**lanker.

Self-hosted AI assistant to automate your life:
- **pi-coding-agent** for agent runtime behavior (sessions, context files, skills/prompts/extensions/themes/packages)
- **SQLite-backed run state + in-process scheduler** for durable run tracking and execution

This README is intentionally short and v0-focused.

For current implemented architecture, see **[`docs/architecture.md`](docs/architecture.md)**.
For deferred APIs, deployment notes, and post-v0 plans, see **[`docs/future.md`](docs/future.md)**.
For testing loops (including Telegram behavioral polling clone), see **[`docs/testing.md`](docs/testing.md)**.
For release/publish procedure, see **[`docs/release.md`](docs/release.md)**.
Release history lives in **[`CHANGELOG.md`](CHANGELOG.md)**.

## Status

- **Pre-alpha.** Expect breaking changes.
- **v0 scope is implemented** (server + CLI + threading semantics + Telegram polling controls). CI merge gating runs in GitHub Actions (`pnpm release:gate`).
- npm publish is tag-driven via GitHub Actions (`vX.Y.Z` tags only, `latest` channel).
- Core server endpoints are in place: `/healthz`, `/v1/messages`, `/v1/runs/:run_id`, auth catalog/login endpoints (`/v1/auth/providers`, `/v1/auth/providers/:provider/login`, `/v1/auth/logins/:attempt_id{,/input,/cancel}`), `/v1/models`, and thread runtime controls (`/v1/threads/:thread_key/{runtime,model,thinking,session}`).
- CLI supports the happy path plus runtime controls: `message`, `run wait`, `health`, `auth providers`, `auth login`, `new`, `model list/get/set`, `thinking get/set`, and local service lifecycle commands (`install`, `status`, `restart`, `uninstall`, `doctor`).
- Default executor runs through pi SDK sessions with SQLite-backed durable run tracking and in-process scheduling/recovery.
- Same-thread queued follow-ups/steers are accepted and run completion is attributed via pi session events (not prompt promise timing).
- Same-thread turn ordering (`followUp` / `steer`) is enforced by per-thread pi session controllers; run dispatch/recovery is in-process and single-server-process scoped in v0.
- Telegram polling adapter is implemented (personal chats), including button-based runtime controls via `/settings`, `/new`, `/model`, `/thinking`, and `/auth`.
- Server/runtime logs are unified on structured Pino JSON with component-scoped child loggers and request completion events.
- Telegram chat UX now streams live run progress in-chat (append-style progress edits + typing indicator + compact `>` tool / `~` thinking snippets) while preserving final run output delivery.
- If Telegram foreground wait times out, the adapter keeps watching in the background and posts the final result when the run completes.
- Model/thinking changes from Telegram button pickers return to the `/settings` panel with updated runtime state.
- Outdated Telegram inline callbacks auto-recover by replacing the menu with the latest `/settings` panel.
- Telegram callback payload limits are enforced; over-limit model/auth options are hidden with an in-chat notice.
- `JAGC_RUNNER=echo` is available for deterministic smoke tests.
- macOS single-user deployment is supported via npm global install + launchd (`jagc install` / `status` / `restart` / `uninstall`). Manual templates remain under `deploy/` as fallback examples.

## Locked v0 technology stack

Source of truth: **[`AGENTS.md`](AGENTS.md)**.

- Runtime: TypeScript (ESM) on Node.js 20 + pnpm
- Server/API: Fastify + Zod + Pino
- CLI: Commander
- Agent/runtime: pi-coding-agent
- Durable run state: SQLite (`runs`, `message_ingest`, `thread_sessions`) + in-process scheduler
- Telegram: grammY (polling first)
- Quality/tooling: Biome + Vitest
- Build: tsdown

## v0 scope (shipped)

Shipped in v0:

- Server:
  - `GET /healthz`
  - `POST /v1/messages` (ingest message, start durable run, return `run_id`)
  - `GET /v1/runs/:run_id` (status/output)
- CLI:
  - `jagc message "..." --json`
  - `jagc run wait <run_id> --json`
  - `jagc install|status|restart|uninstall|doctor` (macOS service lifecycle + diagnostics)
- Telegram:
  - **Polling mode only** for v0
  - Personal chats only
  - One active run per Telegram thread (`thread_key = telegram:chat:<chat_id>`)
  - Queued input behavior aligned with pi semantics (`steer` / `followUp`)
  - `/new` resets the current Telegram thread's pi session; the next message creates a fresh session

### v0 acceptance behavior

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

Canonical layout (v0):

```text
$JAGC_WORKSPACE_DIR/
  AGENTS.md           # auto-created on first startup (global user profile + assistant instructions)
  SYSTEM.md           # auto-created on first startup (global assistant behavior baseline)
  APPEND_SYSTEM.md    # optional
  skills/             # auto-seeded with bundled skills on first startup (no overwrite)
  prompts/            # optional
  extensions/         # auto-seeded with bundled extensions on first startup (no overwrite)
  themes/             # optional
  tools/              # optional
  jagc.json           # optional
  settings.json       # auto-created on first startup (pi workspace settings + default packages)
  .gitignore          # auto-managed: .sessions/, auth.json, git/, jagc.sqlite*
```

## Configuration (v0 minimum)

| Variable | Required | Notes |
| --- | --- | --- |
| `JAGC_DATABASE_PATH` | No | SQLite DB file path (default `$JAGC_WORKSPACE_DIR/jagc.sqlite`; relative paths resolve under `JAGC_WORKSPACE_DIR`) |
| `JAGC_WORKSPACE_DIR` | No | Workspace + pi agent directory (default `~/.jagc`) |
| `JAGC_HOST` | No | Server bind host (default `127.0.0.1`) |
| `JAGC_PORT` | No | Server bind port (default `31415`) |
| `JAGC_API_URL` | No | CLI API target (default `http://127.0.0.1:31415`) |
| `JAGC_RUNNER` | No | `pi` (default) or `echo` for deterministic local/smoke runs |
| `JAGC_LOG_LEVEL` | No | `info` by default (`fatal|error|warn|info|debug|trace|silent`) |
| `JAGC_TELEGRAM_BOT_TOKEN` | No | Required only when Telegram adapter is enabled |
| `JAGC_WEBHOOK_BEARER_TOKEN` | No | Required when generic `POST /v1/webhooks/:source` ingress is enabled |

Auth setup and provider credential details: [`docs/auth.md`](docs/auth.md).

By default jagc uses `JAGC_WORKSPACE_DIR=~/.jagc` for workspace files and sets `JAGC_DATABASE_PATH` to `$JAGC_WORKSPACE_DIR/jagc.sqlite`. On startup it ensures the directory exists, creates `SYSTEM.md`, `AGENTS.md`, and `settings.json` from built-in templates if missing (without overwriting existing files), seeds bundled `defaults/skills/**` and `defaults/extensions/**` files into the workspace if missing (without overwriting existing files), and keeps `.gitignore` entries for `.sessions/`, `auth.json`, `git/`, `jagc.sqlite`, `jagc.sqlite-shm`, and `jagc.sqlite-wal`. The default `settings.json` pre-installs `git:github.com/default-anton/pi-librarian` and `git:github.com/default-anton/pi-subdir-context`; users can edit/remove them later. jagc still does not copy `~/.pi/agent/{settings.json,auth.json}` automatically.

## Quick start (macOS, supported path)

1. Install Node.js 20+ and npm.
2. Install jagc globally:
   - `npm install -g jagc@latest`
3. Install + start the user service:
   - `jagc install`
4. Verify:
   - `jagc status`
   - `jagc health --json`

Update to latest:

- `npm install -g jagc@latest`
- `jagc restart`

Uninstall service (keep workspace data):

- `jagc uninstall`

Uninstall service and delete local workspace data (`~/.jagc` by default):

- `jagc uninstall --purge-data`

Remove the npm package binary as well:

- `npm uninstall -g jagc`

If the service fails to start, run diagnostics:

- `jagc doctor`

## Quick start (dev)

1. `mise install` (rerun when required tools are missing or `.tool-versions` changes)
2. `pnpm install`
3. Set required env vars (see `.env.example`)
4. `pnpm dev` (applies SQL migrations from `migrations/` on startup)
5. Verify:
   - `pnpm smoke`
   - `pnpm test`
   - or manually: `pnpm dev:cli health --json` then `pnpm dev:cli message "ping" --json`
   - inspect provider/model catalog: `pnpm dev:cli model list --json`
   - inspect auth status / start OAuth login: `pnpm dev:cli auth providers --json` and `pnpm dev:cli auth login openai-codex`
   - inspect thread runtime controls: `pnpm dev:cli model get --thread-key cli:default --json` and `pnpm dev:cli thinking get --thread-key cli:default --json`
   - reset thread session: `pnpm dev:cli new --thread-key cli:default --json`

### CLI runtime controls (v0)

```bash
# provider/model catalog
jagc model list --json

# read current thread model + thinking
jagc model get --thread-key cli:default --json
jagc thinking get --thread-key cli:default --json

# reset current thread session (next message starts fresh)
jagc new --thread-key cli:default --json

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
- Hardening path after v0: add HMAC-signed payload verification + replay protection (timestamp/nonce window).
- Run as unprivileged user; keep secrets out of repos.

## License

MIT. See [`LICENSE`](./LICENSE).

---

## Deferred scope

See **[`docs/future.md`](docs/future.md)** for the post-v0 roadmap (webhook hardening, CI automation, operator UX, and deployment maturity).

Pre-v0 long-form draft details were intentionally removed during docs tightening; recover them from git history if needed.
