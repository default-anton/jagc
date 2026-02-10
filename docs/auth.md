# Authentication and model access (v0)

## Current behavior

jagc uses pi SDK auth resolution order for model credentials:

1. Runtime API key override (not used by jagc yet)
2. `auth.json` in `JAGC_WORKSPACE_DIR` (default `~/.jagc/auth.json`)
3. Provider environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
4. Custom provider fallback from `models.json`

`JAGC_WORKSPACE_DIR` is the single directory for both jagc workspace files and pi agent resources (skills, prompts, extensions, themes, settings, auth, sessions).

## Workspace bootstrap

On server startup, jagc ensures `JAGC_WORKSPACE_DIR` exists (mode `0700`), initializes it as a local git repository when `.git` is missing, creates missing defaults (`SYSTEM.md`, `AGENTS.md`, `settings.json`), seeds bundled `defaults/skills/**` and `defaults/extensions/**` files when missing, and ensures workspace `.gitignore` contains:

- `.sessions/`
- `auth.json`
- `git/`

It **does not copy** `~/.pi/agent/settings.json` or `~/.pi/agent/auth.json`.

## Fast setup paths

### Path A: OAuth login via jagc (recommended for remote/headless)

Start from CLI:

```bash
jagc auth providers --json
jagc auth login openai-codex

# optional: make retries/resume deterministic across terminals
jagc auth login openai-codex --owner-key cli:anton:laptop
```

Start from Telegram:

- `/auth` opens provider picker
- tap a provider to start login
- if input is requested, send `/auth input <value>`
- `/auth status` refreshes the current attempt

### Path B: provide env vars to the jagc process

Set provider vars in the environment where the server runs (for macOS launchd: `~/.jagc/service.env`; for Linux/systemd: env file).

On macOS, `jagc install` also writes `~/.jagc/service.env.snapshot` (managed). `~/.jagc/service.env` loads after snapshot and is the right place for persistent overrides.

Examples:

```bash
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
```

For deployment, inject these into your service manager instead of interactive shells.

### Path C: manually manage `auth.json`

You can still pre-populate `JAGC_WORKSPACE_DIR/auth.json` using pi-compatible credentials.

## Discover what is missing

Use the auth/runtime status endpoints via CLI:

```bash
jagc auth providers --json
jagc model list --json
jagc model get --thread-key cli:default --json
jagc thinking get --thread-key cli:default --json
```

This reports:

- per provider auth state (`has_auth`, credential type, env var hint, OAuth support)
- model catalog grouped by provider
- current thread model selection
- current thread thinking level and available thinking levels

## OAuth broker API (implemented)

Server endpoints:

- `POST /v1/auth/providers/:provider/login` — start OAuth login attempt (or return the active one for the same owner + provider)
- `GET /v1/auth/logins/:attempt_id` — inspect current attempt status
- `POST /v1/auth/logins/:attempt_id/input` — submit requested input (`prompt` or `manual_code`)
- `POST /v1/auth/logins/:attempt_id/cancel` — cancel attempt

Ownership/isolation rules:

- OAuth attempts are scoped by `X-JAGC-Auth-Owner`.
- `POST /login` accepts an optional owner header; if omitted, jagc generates one.
- Follow-up endpoints (`GET`, `/input`, `/cancel`) require `X-JAGC-Auth-Owner`.
- Attempt operations with the wrong owner return `404` to avoid cross-client/session leakage.

Attempt snapshots include:

- owner key + provider + attempt id
- current status (`running|awaiting_input|succeeded|failed|cancelled`)
- browser URL/instructions (when available)
- requested input prompt (when waiting for user input)
- progress messages and terminal error text

Successful logins are persisted to `auth.json` through pi `AuthStorage.login()` and are used immediately by `ModelRegistry`.
