# Authentication and model access (v0)

## Current behavior

jagc uses pi SDK auth resolution order for model credentials:

1. Runtime API key override (not used by jagc yet)
2. `auth.json` in `JAGC_WORKSPACE_DIR` (default `~/.jagc/auth.json`)
3. Provider environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
4. Custom provider fallback from `models.json`

`JAGC_WORKSPACE_DIR` is the single directory for both jagc workspace files and pi agent resources (skills, prompts, extensions, themes, settings, auth, sessions).

## One-time migration bootstrap

On server startup, jagc performs a one-time bootstrap:

- creates `JAGC_WORKSPACE_DIR` if missing
- copies `~/.pi/agent/settings.json` -> `JAGC_WORKSPACE_DIR/settings.json` if destination is missing
- copies `~/.pi/agent/auth.json` -> `JAGC_WORKSPACE_DIR/auth.json` if destination is missing

It does **not** copy skills/extensions/prompts/themes.

## Fast setup paths

### Path A: use default workspace directory (recommended now)

Use default `JAGC_WORKSPACE_DIR=~/.jagc`.

On first run, bootstrap copies your existing `~/.pi/agent/{settings.json,auth.json}` once when missing.

### Path B: provide env vars to the jagc process

Set provider vars in the environment where the server runs (shell, launchd env, systemd env file).

Examples:

```bash
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
```

For deployment, inject these into your service manager instead of interactive shells.

## Discover what is missing

Use the auth status endpoint via CLI:

```bash
jagc auth providers --json
```

This reports, per provider:

- whether auth is configured (`has_auth`)
- credential type (`api_key` or `oauth` when in `auth.json`)
- env var hint (`env_var_hint`) when applicable
- available model count vs total model count

## OAuth in remote homelab deployments

Current v0 baseline: OAuth login is still done through interactive `pi` on the server host (or any host that shares the same `JAGC_WORKSPACE_DIR` files).

### Planned follow-up (design target)

Implement a jagc-managed OAuth broker workflow:

1. Start login from CLI/Telegram (`auth login <provider>`)
2. jagc runs `AuthStorage.login()` with callback bridging
3. jagc returns either:
   - browser URL
   - or device code + verification URL
4. user completes auth from any device
5. jagc stores refreshed tokens in `auth.json`

This works for headless servers and avoids requiring shell access for `/login`.
