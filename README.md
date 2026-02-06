# jagc

> **jagc** = **j**ust **a** **g**ood **c**lanker.

Self-hosted AI assistant to automate your life:
- **pi-coding-agent** for agent runtime behavior (sessions, context files, skills/prompts/extensions/themes/packages)
- **DBOS Transact (TypeScript)** for durable workflow execution (Postgres-backed)

This README is intentionally short and MVP-focused.

For detailed architecture drafts, deferred APIs, deployment notes, and post-MVP plans, see **[`docs/future.md`](docs/future.md)**.

## Status

- **Pre-alpha.** Expect breaking changes.
- **Deployment assets under `deploy/` are drafts** (not a supported install path yet).

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
| `JAGC_WORKSPACE_DIR` | Yes | Path to user workspace repo |
| `JAGC_PORT` | No | Defaults to `31415` |
| `JAGC_API_URL` | No | CLI API target (default `http://127.0.0.1:31415`) |
| `PI_CODING_AGENT_DIR` | No | pi config/state dir (default `~/.pi/agent`) |
| `JAGC_TELEGRAM_BOT_TOKEN` | No | Required only when Telegram adapter is enabled |

## Quick start (dev, intended)

1. Start Postgres
2. `pnpm install`
3. Set required env vars
4. `pnpm dev`
5. Verify:
   - `jagc health`
   - `jagc message "ping" --json`

## Security baseline

- Workspace code is **trusted** and runs with server permissions.
- Third-party pi packages are **trusted code**; review before installing.
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
