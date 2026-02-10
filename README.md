# jagc

**jagc** ("just a good clanker") is a self-hosted AI assistant you run on your own machine.

**Primary UX is Telegram.** The CLI/API are there for setup, control, and debugging.

It gives you:
- Telegram chat interface for day-to-day use
- local API + CLI (`jagc ...`) for ops/runtime control
- durable run tracking (SQLite)
- pi-coding-agent runtime features (sessions, skills, prompts, extensions)

> **Status: pre-alpha.** It works today, but expect breaking changes.

## Who this is for

- You can run a few terminal commands.
- You want a self-hosted assistant without building infra from scratch.
- You expect Telegram-first interaction, not a web UI.

## Quick start (Telegram-first, macOS)

> Supported service-management path today: macOS (`jagc install`). Linux/Windows service commands are not implemented yet.

### Prerequisites
- Node.js `>=20.19.0 <21` or `>=22.9.0`
- npm
- Telegram account
- A bot token from `@BotFather`

### BotFather in 3 steps

1. In Telegram, open `@BotFather` and send `/newbot`.
2. Pick a display name + unique bot username (must end with `bot`, e.g. `anton_helper_bot`).
3. Copy the HTTP API token from BotFather (`123456:ABC...`) and keep it secret.

You can always fetch it again later with `/token` in `@BotFather`.

### 1) Install jagc

```bash
npm install -g jagc@latest
```

### 2) Install/start service with Telegram enabled

```bash
jagc install --telegram-bot-token <YOUR_BOT_TOKEN>
jagc status
jagc health --json
```

### 3) Chat with your bot in Telegram

- Open your bot chat
- Send `/settings` to check runtime state
- Send a normal message to run the assistant

### 4) If something is off

```bash
jagc doctor
jagc status
```

## CLI/API are still useful (but secondary)

Use CLI when you need explicit control:

```bash
jagc message "ping" --json
jagc run wait <run_id> --json
jagc model list --json
jagc model set <provider/model> --thread-key cli:default --json
jagc share --thread-key cli:default --json
```

`jagc share` / Telegram `/share` require GitHub CLI (`gh`) installed and authenticated (`gh auth login`) and upload session HTML as a secret gist.

## What works in v0

- Local server: `GET /healthz`, `POST /v1/messages`, `GET /v1/runs/:run_id`, `POST /v1/threads/:thread_key/share`
- CLI: `health`, `message`, `run wait`, `new`, `share`, `model list|get|set`, `thinking get|set`, `auth providers|login`
- Telegram polling adapter (personal chats) with `/settings`, `/new`, `/share`, `/model`, `/thinking`, `/auth`
- Telegram progress stream shows tool/thinking snippets; before the first snippet, a short placeholder line appears for faster feedback and is deleted if no snippets ever arrive
- Runtime semantics: same-thread `followUp` (default) and explicit `steer`
- System-prompt context is extension-driven: global `AGENTS.md`, available skills, and Codex harness notes are injected by default workspace extensions (SDK built-in AGENTS/skills auto-loading is disabled)
- In-process scheduling + SQLite-backed recovery after restart

## Mental model (important)

- A **thread** is a conversation lane (`thread_key`).
- A **run** is one assistant execution attempt (`run_id`).
- Same thread = ordered turns; different threads can run concurrently.
- Workspace defaults to `~/.jagc` and is auto-initialized as a local git repository.

## Minimal config

Most users only need the Telegram token at install time.

| Variable | Default | Why you might set it |
| --- | --- | --- |
| `JAGC_TELEGRAM_BOT_TOKEN` | unset | Enable Telegram (primary UX) |
| `JAGC_WORKSPACE_DIR` | `~/.jagc` | Move workspace/data location |
| `JAGC_DATABASE_PATH` | `$JAGC_WORKSPACE_DIR/jagc.sqlite` | Custom DB path |
| `JAGC_HOST` | `127.0.0.1` | Bind a different host |
| `JAGC_PORT` | `31415` | Bind a different port |
| `JAGC_API_URL` | `http://127.0.0.1:31415` | Point CLI at another server |
| `JAGC_RUNNER` | `pi` | Use `echo` for deterministic smoke/testing |
| `PI_SHARE_VIEWER_URL` | `https://pi.dev/session/` | Override `/share` viewer base URL (must be absolute URL) |

### Service environment (macOS launchd)

`jagc install` creates two workspace env files for launchd:

- `~/.jagc/service.env.snapshot` — managed by jagc (captured from your login shell; includes PATH/tooling env for brew/mise/uv/asdf/etc.)
- `~/.jagc/service.env` — user overrides (never overwritten by `jagc install` once created)

launchd loads both files on startup (`snapshot` first, then `service.env`), so values in `service.env` win.

This path depends on Node's `--env-file-if-exists` flag, so use Node `>=20.19.0 <21` or `>=22.9.0`.

After editing either file, run:

```bash
jagc restart
```

Auth provider setup details: [`docs/auth.md`](docs/auth.md)

## Security baseline

- Your workspace and installed packages are **trusted code**.
- Local CLI usage is unauthenticated in v0.
- Webhook ingress requires bearer token auth.
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

## Docs map

- Architecture (implemented behavior): [`docs/architecture.md`](docs/architecture.md)
- Testing loops: [`docs/testing.md`](docs/testing.md)
- Release process: [`docs/release.md`](docs/release.md)
- Deferred roadmap: [`docs/future.md`](docs/future.md)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT. See [`LICENSE`](LICENSE).
