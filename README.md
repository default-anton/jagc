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
- Scheduled tasks (one-off + recurring) with per-task execution threads
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

### 3) Open Telegram and authorize the first user

- Send any message to your bot.
- On first contact, the bot replies with an exact command like:

  ```bash
  jagc telegram allow --user-id <id>
  ```

- Run that command in terminal (it updates `~/.jagc/service.env` and restarts the service).
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
# safe/idempotent: refresh launchd plist + service env snapshot
jagc install
jagc status

jagc defaults sync
jagc packages update
```

- `install` is safe to rerun and ensures launchd points at the currently installed jagc server entrypoint.
- `defaults sync` refreshes bundled `skills/**` and `extensions/**` in your workspace without deleting your custom files.
- `packages update` updates workspace pi packages using jagc's bundled pi dependency.

## Day-to-day usage

### Telegram commands (primary)

- `/settings` — runtime/settings panel
- `/cancel` — stop active run in this chat (session preserved)
- `/new` — reset this chat's session
- `/delete` — delete the current Telegram topic thread
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
jagc message "describe these" -i ./a.jpg -i ./b.png --json
jagc run wait <run_id> --json
jagc cancel --thread-key cli:default --json
jagc new --thread-key cli:default --json
jagc model list --json
jagc model set <provider/model> --thread-key cli:default --json
jagc thinking get --thread-key cli:default --json
jagc auth providers --json
jagc telegram list --json
jagc telegram allow --user-id <telegram_user_id>
jagc task create --title "Daily plan" --instructions "Prepare priorities" --cron "0 9 * * 1-5" --timezone "America/Los_Angeles" --thread-key telegram:chat:<chat_id> --json
jagc task create --title "Monthly planning" --instructions "Prepare monthly priorities" --rrule "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;BYHOUR=9;BYMINUTE=0;BYSECOND=0" --timezone "America/Los_Angeles" --thread-key telegram:chat:<chat_id> --json
jagc task list --state all --json
jagc task run <task_id> --wait --timeout 60 --json
jagc share --thread-key cli:default --json
```

`jagc task create` defaults to `$JAGC_THREAD_KEY` when present (jagc agent `bash` calls set this per active thread). Without that env var, it defaults to `cli:default`.

`jagc share` / Telegram `/share` require GitHub CLI (`gh`) installed and authenticated (`gh auth login`).

## Current capabilities

### Runtime + durability

- In-process scheduling with SQLite-backed recovery after restart
- Scheduled task domain (`scheduled_tasks`, `scheduled_task_runs`) with durable due-queue processing, idempotent dispatch, and restart recovery for pending/dispatched task runs
- Recurrence scheduling supports one-off (`once_at`), cron (`cron`), and calendar rules (`rrule`) with timezone-aware next-run computation
- Thread→session persistence (`thread_key -> session`) survives process restarts
- Same-thread turn ordering enforced by per-thread pi session controller
- Structured run payload contract (`output` is structured; not plain-text-only)
- Temporary image staging in SQLite `input_images` for both run-linked and Telegram-pending rows (purged on message/image ingest-triggered TTL cleanup; run-linked rows deleted after successful pi message submission)

### API

- Health/lifecycle: `GET /healthz`, `POST /v1/messages`, `GET /v1/runs/:run_id`
- `POST /v1/messages` supports optional `images[]` (`mime_type`, `data_base64`, optional `filename`) with consistent limits: max 10 images, max 50MiB decoded total, allowed MIME types `image/jpeg|image/png|image/webp|image/gif`, and `idempotency_payload_mismatch` conflict (`409`) on same-key/different-payload retries
- Scheduled tasks: `POST /v1/threads/:thread_key/tasks`, `GET /v1/tasks`, `GET /v1/tasks/:task_id`, `PATCH /v1/tasks/:task_id`, `DELETE /v1/tasks/:task_id`, `POST /v1/tasks/:task_id/run-now`
- Runtime controls: cancel/new/share/model/thinking endpoints
- OAuth broker endpoints for provider login flows

### CLI

- Message/run lifecycle: `message`, `run wait`, `cancel`, `new`, `share`
- Scheduled tasks: `task create|list|get|update|delete|run [--wait]|enable|disable` (`task list --state <all|enabled|disabled>`, `task create|update --rrule <rule>`)
- Runtime controls: `model list|get|set`, `thinking get|set`
- Auth: `auth providers|login`
- Workspace/runtime ops: `defaults sync`, `packages install|remove|update|list|config`
- Service ops (macOS): `install|status|restart|uninstall|doctor`
- Designed as an agent/script-friendly control plane for self-debugging and adaptation

### Telegram adapter

- Long polling (personal chats)
- Commands: `/settings`, `/cancel`, `/new`, `/delete`, `/share`, `/model`, `/thinking`, `/auth`, `/steer`
- Incoming photo/image-document messages are persisted immediately into SQLite `input_images` pending buffer (`run_id=NULL`) scoped by `(source, thread_key, user_key)`; bot replies `Saved N image(s). Send text instructions.` and does not create a run yet.
- Next inbound text/`/steer` ingest for that same Telegram chat+user claims pending buffered images transactionally into the new run, refreshes image TTL, and preserves deterministic attach order.
- Telegram pending image buffer limits match API/CLI limits (max 10 images, max 50MiB decoded bytes total); over-limit pending scope rejects with `image_buffer_limit_exceeded`.
- Telegram image buffering is idempotent by `update_id` (replayed Telegram updates do not duplicate staged rows or re-send waiting hints).
- Telegram image handlers reject `file_size` values above the decoded 50MiB cap before downloading bytes (`image_total_bytes_exceeded`).
- Topic-aware routing: inbound private-chat topic messages map to `telegram:chat:<chat_id>:topic:<message_thread_id>`; Telegram general topic (`message_thread_id=1`) is normalized to base chat routing (`telegram:chat:<chat_id>`) to avoid Bot API `message thread not found` sends.
- `/delete` removes the current Telegram topic thread (only when called inside a topic), clears the corresponding jagc session mapping, and clears any scheduled-task execution-thread binding for that topic so the next task run recreates a fresh topic.
- Scheduled task runs always use a dedicated per-task topic. On first due/run-now, jagc lazily creates and persists a task-owned topic named from the task title (`<title>`, trimmed to Telegram limits) and routes progress/final delivery inside that topic thread (including tasks created from base/default chats and creator topic threads).
- Task title updates rename only task-owned topics; creator-origin topics are never renamed.
- Scheduled task topic creation requires Telegram private topics enabled for the bot (`getMe().has_topics_enabled=true`). Capability is read at adapter startup, so restart jagc after toggling topic mode in BotFather.
- Final assistant replies are rendered from Markdown into Telegram `entities` (no `parse_mode` string escaping path)
- Short code fences render inline as Telegram code blocks; oversized code fences are sent as document attachments with language-aware filenames (for example `snippet-1.ts`)
- Telegram-thread pi sessions expose a `telegram_send_files` tool for direct outbound delivery (photos via `sendPhoto`/`sendMediaGroup`, then videos via `sendVideo`, then audios via `sendAudio`, then documents via `sendDocument`; `auto` routing is conservative: photo magic-byte + <=10MB check first, then `.mp4`/`.mp3`/`.m4a`, else document)
- Incoming assistant-bound user text messages get a best-effort random emoji reaction (from a curated working set) so users get instant "got it" feedback before output arrives
- Progress stream with thinking/tool snippets and tool completion status updates (separate thinking content blocks render as separate `~` lines)
- Long progress logs split into continuation messages to preserve visibility

### Known limitations

- Service management is macOS launchd-first (Linux/Windows not implemented yet)
- Telegram webhook mode is intentionally unsupported in core (polling only)
- Scheduled task topic creation in Telegram depends on bot private topics mode (`has_topics_enabled`)
- Multi-process global per-thread locking is deferred post-v0

## Minimal configuration

Most users only need to set Telegram token once at install.

| Variable                  | Default                           | Why you might set it                                      |
| ---                       | ---                               | ---                                                       |
| `JAGC_TELEGRAM_BOT_TOKEN` | unset                             | Enable Telegram (primary UX)                              |
| `JAGC_TELEGRAM_ALLOWED_USER_IDS` | unset (deny all)           | Comma-separated Telegram user ids allowed to chat (`123,456`); use `jagc telegram allow --user-id <id>` |
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
- Telegram access is deny-by-default and controlled by `JAGC_TELEGRAM_ALLOWED_USER_IDS` (managed via `jagc telegram allow ...`).
- Webhook ingress (when used) requires bearer token auth.
- Run jagc as a normal (non-root) user.

## Update / remove

```bash
npm install -g jagc@latest

# recommended on macOS service installs: rewrites launchd plist to current paths
jagc install
# if you skip install, at least restart
jagc restart

# uninstall service (keep data)
jagc uninstall

# uninstall service + workspace data (~/.jagc by default)
jagc uninstall --purge-data
```

## Operator/dev feedback loops

- Local dev server: `pnpm dev` (prepends a repo-local `jagc` shim so agent `bash` calls use `pnpm dev:cli`, not a globally installed `jagc`)
- Fast end-to-end smoke (echo runner): `pnpm smoke`
- Smoke through real pi runtime: `JAGC_RUNNER=pi pnpm smoke`
- Full suite (includes Telegram behavioral clone tests): `pnpm test`
- Local release gate: `pnpm release:gate`

## Docs map

- Architecture (system model + invariants): [`docs/architecture.md`](docs/architecture.md)
- Operations/service lifecycle: [`docs/operations.md`](docs/operations.md)
- Telegram adapter contract: [`docs/telegram.md`](docs/telegram.md)
- Auth details: [`docs/auth.md`](docs/auth.md)
- Testing loops: [`docs/testing.md`](docs/testing.md)
- Release process: [`docs/release.md`](docs/release.md)
- Tooling notes: [`docs/tooling.md`](docs/tooling.md)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT. See [`LICENSE`](LICENSE).
