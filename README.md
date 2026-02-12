# jagc

**jagc** ("just a good clanker") is a self-hosted AI assistant.

**Primary UX is Telegram.** The CLI/API are the control plane: setup, control, debugging, and self-maintenance.

> **Status: pre-alpha.** Useful today, but expect breaking changes.

## Who this is for

- You can run a few terminal commands.
- You want a self-hosted assistant without building infra from scratch.
- You expect Telegram-first interaction, not a web UI.

## What you get

- Telegram chat interface for day-to-day use
- Local server + CLI (`jagc ...`) as a control plane for operators and agent self-maintenance
- Durable run/thread state in SQLite
- pi-coding-agent runtime features (sessions, skills, prompts, extensions)

## Mental model (2 minutes)

- A **thread** is a conversation lane (`thread_key`).
- A **run** is one assistant execution (`run_id`).
- Same thread = ordered turns.
- Different threads can run concurrently.
- Normal messages use `followUp` (default). Interrupting turns are explicit `steer`.

Default workspace: `~/.jagc` (auto-initialized as a local git repo).

## Quick start (Telegram-first, macOS)

> Supported service-management path today: **macOS only** (`jagc install`). Linux/Windows service lifecycle commands are not implemented yet.

### Prerequisites

- Node.js `>=20.19.0 <21` or `>=22.9.0`
- npm
- Telegram account
- Bot token from `@BotFather`

### BotFather in 3 steps

1. In Telegram, open `@BotFather` and send `/newbot`.
2. Pick a display name and unique bot username (must end with `bot`, for example `anton_helper_bot`).
3. Copy the HTTP API token (`123456:ABC...`) and keep it secret.

### 1) Install jagc

```bash
npm install -g jagc@latest
```

### 2) Install/start the background service

```bash
jagc install --telegram-bot-token <YOUR_BOT_TOKEN>
jagc status
jagc health --json
```

### 3) Open Telegram and validate the loop

- Send `/settings` (runtime state should render)
- Send a normal message (assistant should run)
- Send `/cancel` during a long run (stops run, keeps session)

### 4) If something is off

```bash
jagc doctor
jagc status
```

### 5) After upgrading jagc

```bash
jagc defaults sync
jagc packages update
```

- `defaults sync` refreshes bundled `skills/**` and `extensions/**` in your workspace without deleting your custom files.
- `packages update` updates workspace pi packages using jagc's bundled pi dependency.

## Day-to-day usage

### Telegram commands (primary)

- `/settings` — runtime/settings panel
- `/cancel` — stop active run in this chat (session preserved)
- `/new` — reset this chat's session
- `/share` — export session HTML + upload secret gist
- `/model` — model picker
- `/thinking` — thinking level picker
- `/auth` — provider auth flow
- `/steer <message>` — explicit interrupting turn
- Unknown slash commands are forwarded to the assistant as normal messages

### CLI control plane (agent-facing first)

The CLI is intentionally built so **jagc can inspect, fix, and adapt itself** (with you in the loop). It is the surface for run lifecycle debugging, thread/session repair (`cancel`/`new`), runtime tuning (`model`/`thinking`), auth bootstrap, defaults/package updates, and service diagnostics.

```bash
jagc --version
jagc message "ping" --json
jagc run wait <run_id> --json
jagc cancel --thread-key cli:default --json
jagc new --thread-key cli:default --json
jagc model list --json
jagc model set <provider/model> --thread-key cli:default --json
jagc thinking get --thread-key cli:default --json
jagc auth providers --json
jagc share --thread-key cli:default --json
```

`jagc share` / Telegram `/share` require GitHub CLI (`gh`) installed and authenticated (`gh auth login`).

## Current capabilities

### Runtime + durability

- In-process scheduling with SQLite-backed recovery after restart
- Thread→session persistence (`thread_key -> session`) survives process restarts
- Same-thread turn ordering enforced by per-thread pi session controller
- Structured run payload contract (`output` is structured; not plain-text-only)

### API

- Health/lifecycle: `GET /healthz`, `POST /v1/messages`, `GET /v1/runs/:run_id`
- Runtime controls: cancel/new/share/model/thinking endpoints
- OAuth broker endpoints for provider login flows

### CLI

- Message/run lifecycle: `message`, `run wait`, `cancel`, `new`, `share`
- Runtime controls: `model list|get|set`, `thinking get|set`
- Auth: `auth providers|login`
- Workspace/runtime ops: `defaults sync`, `packages install|remove|update|list|config`
- Service ops (macOS): `install|status|restart|uninstall|doctor`
- Designed as an agent/script-friendly control plane for self-debugging and adaptation

### Telegram adapter

- Long polling (personal chats)
- Commands: `/settings`, `/cancel`, `/new`, `/share`, `/model`, `/thinking`, `/auth`, `/steer`
- Progress stream with thinking/tool snippets and tool completion status updates
- Long progress logs split into continuation messages to preserve visibility

### Known limitations

- Service management is macOS launchd-first (Linux/Windows not implemented yet)
- Telegram webhook mode is intentionally unsupported in core (polling only)
- Multi-process global per-thread locking is deferred post-v0

## Minimal configuration

Most users only need to set Telegram token once at install.

| Variable                  | Default                           | Why you might set it                                      |
| ---                       | ---                               | ---                                                       |
| `JAGC_TELEGRAM_BOT_TOKEN` | unset                             | Enable Telegram (primary UX)                              |
| `JAGC_WORKSPACE_DIR`      | `~/.jagc`                         | Move workspace/data location                              |
| `JAGC_DATABASE_PATH`      | `$JAGC_WORKSPACE_DIR/jagc.sqlite` | Custom DB path                                            |
| `JAGC_HOST`               | `127.0.0.1`                       | Bind a different host                                     |
| `JAGC_PORT`               | `31415`                           | Bind a different port                                     |
| `JAGC_API_URL`            | `http://127.0.0.1:31415`          | Point CLI at another server                               |
| `JAGC_RUNNER`             | `pi`                              | Use `echo` for deterministic smoke/testing                |
| `PI_SHARE_VIEWER_URL`     | `https://pi.dev/session/`         | Override `/share` viewer base URL (absolute URL required) |

### Service environment files (macOS launchd)

`jagc install` manages two workspace env files:

- `~/.jagc/service.env.snapshot` — managed by jagc (captured from your login shell)
- `~/.jagc/service.env` — user overrides (not overwritten after first creation)

Launchd loads `snapshot` first, then `service.env` (so user overrides win).
After editing either file:

```bash
jagc restart
```

If you rerun `jagc install` without `--telegram-bot-token`, existing token in `service.env` is preserved.

## Security baseline

- Workspace and installed packages are **trusted code**.
- Local CLI usage is unauthenticated.
- Webhook ingress (when used) requires bearer token auth.
- Run jagc as a normal (non-root) user.

## Update / remove

```bash
npm install -g jagc@latest
jagc restart

# uninstall service (keep data)
jagc uninstall

# uninstall service + workspace data (~/.jagc by default)
jagc uninstall --purge-data
```

## Operator/dev feedback loops

- Fast end-to-end smoke (echo runner): `pnpm smoke`
- Smoke through real pi runtime: `JAGC_RUNNER=pi pnpm smoke`
- Full suite (includes Telegram behavioral clone tests): `pnpm test`
- Local release gate: `pnpm release:gate`

## Docs map

- Architecture (implemented behavior): [`docs/architecture.md`](docs/architecture.md)
- Auth details: [`docs/auth.md`](docs/auth.md)
- Testing loops: [`docs/testing.md`](docs/testing.md)
- Release process: [`docs/release.md`](docs/release.md)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT. See [`LICENSE`](LICENSE).
