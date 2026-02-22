# Operations and service lifecycle

This doc captures workspace bootstrap and runtime/service operations behavior.

## Workspace bootstrap

- Startup bootstraps `JAGC_WORKSPACE_DIR` (`~/.jagc` by default) with directory mode `0700`.
- Bootstrap creates default `SYSTEM.md`, `AGENTS.md`, and `settings.json` from repo templates when missing (does not overwrite by default).
- Bootstrap also seeds bundled `defaults/skills/**`, `defaults/extensions/**`, and `defaults/memory/**` files into the workspace when missing (does not overwrite by default), including context-injection extensions for runtime/harness context + AGENTS hierarchy/authoring rules, global AGENTS.md file loading, skills listing, local pi docs/examples references, Codex harness instructions, and markdown memory scaffolding.
- Dev-only overwrite mode (`JAGC_DEV_OVERWRITE_DEFAULTS=1`, enabled by `pnpm dev`) rewrites workspace `SYSTEM.md`, `AGENTS.md`, bundled `defaults/skills/**`, bundled `defaults/extensions/**`, and bundled `defaults/memory/**` on each startup, while preserving existing `settings.json`.
- `pnpm dev` prepends a repo-local `scripts/dev-bin/jagc` shim to `PATH`, so agent `bash` calls to `jagc` resolve to `pnpm dev:cli` from the current checkout instead of any globally installed `jagc` binary.
- Default `settings.json` includes bootstrap pi packages (`pi-librarian`, `pi-subdir-context`) but remains user-editable after creation.
- `jagc packages ...` is a thin wrapper around the bundled `@mariozechner/pi-coding-agent` package manager CLI (`dist/cli.js`), executed with `PI_CODING_AGENT_DIR=<workspace>` and `cwd=<workspace>` so package operations target the jagc workspace and do not depend on a globally installed `pi` binary.
- Bootstrap initializes `JAGC_WORKSPACE_DIR` as a local git repository (`git init`) when `.git` is missing.
- Bootstrap ensures workspace `.gitignore` has `.sessions/`, `auth.json`, `git/`, `service.env`, `service.env.snapshot`, `jagc.sqlite`, `jagc.sqlite-shm`, and `jagc.sqlite-wal` entries.

## macOS service lifecycle (CLI-managed)

- `jagc install` writes a per-user launch agent at `~/Library/LaunchAgents/<label>.plist` (`com.jagc.server` by default), then `launchctl bootstrap` + `kickstart` starts the service.
- launchd runs `node --env-file-if-exists=<workspace>/service.env.snapshot --env-file-if-exists=<workspace>/service.env <installed package>/dist/server/main.mjs`.
- Server startup re-applies those same env files in-order with explicit override semantics so launchd defaults (notably `PATH`) do not mask workspace env entries.
- Node runtime requirement for this launch path is `>=20.19.0 <21` or `>=22.9.0`.
- `jagc install` always regenerates `<workspace>/service.env.snapshot` from the user's login shell (PATH/tooling env) and creates `<workspace>/service.env` when missing.
- `service.env` is never wholesale-overwritten by `jagc install` once it exists; user edits are picked up after `jagc restart`.
- `jagc install --telegram-bot-token ...` upserts `JAGC_TELEGRAM_BOT_TOKEN` into `<workspace>/service.env`; rerunning install without that flag preserves any existing token in `service.env`.
- launchd plist environment variables include `JAGC_WORKSPACE_DIR`, `JAGC_DATABASE_PATH`, `JAGC_HOST`, `JAGC_PORT`, `JAGC_RUNNER`, and `JAGC_LOG_LEVEL` (Telegram token comes from env files).
- Logs default to `$JAGC_WORKSPACE_DIR/logs/server.out.log` and `server.err.log`.
- `jagc status` inspects launchd (`launchctl print`) and API health (`/healthz`).
- `jagc restart` issues `launchctl kickstart -k` and waits for `/healthz`.
- `jagc uninstall` removes the launch agent and unloads it; `--purge-data` additionally deletes the workspace directory.

## Service env files (launchd)

- `service.env.snapshot` is managed by jagc and refreshed on install.
- `service.env` is operator-managed and intended for persistent overrides.
- launchd and server startup load `snapshot` first, then `service.env`.
- After editing env files, run `jagc restart`.

## Validation loop

- Fast smoke (echo runner): `pnpm smoke`
- Real pi runtime smoke: `JAGC_RUNNER=pi pnpm smoke`
- Full suite: `pnpm test`
- Release gate: `pnpm release:gate`
