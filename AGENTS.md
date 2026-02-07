# Rules you must follow in this project

- Always read README.md for context before doing anything else.
- Run `mise install` at repo root when required tools are missing or after `.tool-versions` changes.
- For `mise install` troubleshooting, read `docs/tooling.md`.

## Dev feedback loop commands (use these, not ad-hoc)

- Start local Postgres: `pnpm db:start`
- Ensure dev DB exists: `pnpm db:createdb`
- Check Postgres readiness: `pnpm db:status`
- Stop local Postgres: `pnpm db:stop`
- Run fast end-to-end smoke (echo runner): `pnpm smoke`
- Run smoke through real pi runtime: `JAGC_RUNNER=pi pnpm smoke`
- Run quality gate before handoff: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

## Repo map (agent quick orientation)

- `README.md` — MVP contract, quick start, env/config defaults.
- `package.json` — canonical scripts: `dev`, `dev:cli`, `db:*`, `smoke`, `typecheck/lint/test/build`.
- `src/server/main.ts` — server entrypoint (config, migrations, Fastify boot).
- `src/server/app.ts` — HTTP routes (`/healthz`, `/v1/messages`, `/v1/runs/:run_id`, `/v1/auth/providers`, `/v1/models`, `/v1/threads/:thread_key/{runtime,model,thinking}`).
- `src/server/{service,scheduler,store,executor}.ts` — run lifecycle, DBOS queueing, persistence, runner wiring.
- `src/runtime/{pi-executor,thread-run-controller,pi-auth,agent-dir-bootstrap}.ts` — pi SDK sessions, same-thread control, auth/workspace bootstrap.
- `src/adapters/telegram-polling.ts` — Telegram polling adapter, text ingress, and callback-query routing.
- `src/adapters/telegram-runtime-controls.ts` + `src/adapters/telegram-controls-callbacks.ts` — button-based runtime UX (`/settings`, `/model`, `/thinking`) and callback payload parsing.
- `src/cli/main.ts` + `src/cli/client.ts` — CLI commands and server client (`auth providers`, `model list|get|set`, `thinking get|set`).
- `src/shared/{api-contracts,config,run-types}.ts` — shared contracts/types/config parsing.
- `migrations/*.sql` — Postgres schema and durable run tables.
- `tests/*.test.ts` — subsystem coverage (API, store, config, threading, bootstrap).
- `scripts/dev-postgres.sh` + `scripts/smoke.sh` — sanctioned local feedback loop scripts.
- `docs/architecture.md` = implemented design, `docs/future.md` = deferred scope, `docs/auth.md` = auth/provider setup.
- `deploy/` — draft launchd/systemd assets (not supported install path yet).
- `dist/` — build output; never hand-edit.

## v0 locked product decisions

- First version includes Telegram support (polling mode) in addition to server + CLI.
- `output` contract is structured payloads (not plain text only).
- Same-thread default delivery mode is `followUp`; `steer` is explicit opt-in.
- Build toward single-host production deployment from day one (keep local dev simple).
- No auth required for local CLI usage; webhook ingress must use token-based authentication.
- Provider/model/thinking selection is delegated to pi settings (do not duplicate in jagc DB).
- Telegram UX must include button-based model/thinking controls via `/settings`, `/model`, and `/thinking`.
- v0 deployment target starts with macOS single-host using `.env` configuration.

## v0 locked implementation baseline

- Runtime: TypeScript (ESM) on Node.js 20 + pnpm.
- Server/API: Fastify + Zod + Pino.
- CLI: Commander.
- Agent runtime: pi-coding-agent.
- Durable execution + DB: DBOS Transact + Postgres.
- Telegram adapter: grammY (polling mode first).
- Quality/tooling: Biome + Vitest.
- Build: tsdown.
- Webhook auth baseline:
  - Generic `POST /v1/webhooks/:source` requires `Authorization: Bearer <token>`.
  - Telegram webhook mode requires `X-Telegram-Bot-Api-Secret-Token` verification.
- Webhook hardening path (post-v0): HMAC request signatures + replay protection (timestamp/nonce window).

## Pi integration decision (v0)

- Use the pi **SDK** in-process (`createAgentSession`) for jagc server/runtime.
- Do **not** use RPC mode for primary runtime paths.
- Use RPC only for optional cross-language clients or external process-isolation use cases.

### Pi capabilities we will use

- Create/manage sessions via `createAgentSession` + `SessionManager`; map `thread_key -> session` in jagc and keep one active run per thread.
- Enforce queue semantics via `AgentSession.prompt(..., { streamingBehavior })`, `steer()`, and `followUp()`.
- Keep provider/model/thinking in pi via `ModelRegistry`, `AuthStorage`, `setModel()`, and `setThinkingLevel()` (no duplicate jagc DB state).
- Load workspace/global context and customizations via `DefaultResourceLoader` + `SettingsManager` (AGENTS/SYSTEM/APPEND_SYSTEM, skills, prompts, extensions, themes).
- Drive run lifecycle and structured output via `session.subscribe(...)` events (`agent_start`, `message_update`, `tool_execution_*`, `agent_end`).

### Pi docs (absolute paths)

- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/README.md`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/docs/rpc.md`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/docs/settings.md`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/docs/providers.md`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/docs/models.md`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/docs/skills.md`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/docs/prompt-templates.md`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/docs/packages.md`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/docs/session.md`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/docs/custom-provider.md`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/examples/README.md`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/examples/sdk/README.md`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/examples/sdk/01-minimal.ts`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/examples/sdk/02-custom-model.ts`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/examples/sdk/06-extensions.ts`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/examples/sdk/09-api-keys-and-oauth.ts`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/examples/sdk/10-settings.ts`
- `/Users/akuzmenko/.local/share/mise/installs/npm-mariozechner-pi-coding-agent/0.52.7/lib/node_modules/@mariozechner/pi-coding-agent/examples/sdk/12-full-control.ts`

## Current v0 build order (high-level)

Ship a runnable vertical slice first, then harden.

Status legend: `[x] done`, `[~] partial`, `[ ] pending`.

1. [x] Server skeleton + durability
   - `GET /healthz`, `POST /v1/messages`, `GET /v1/runs/:run_id` implemented.
   - Run state transitions (`running|succeeded|failed`) + idempotent ingest implemented.
2. [x] CLI happy path + runtime controls
   - `jagc message "..." --json` and `jagc run wait <run_id> --json` implemented.
   - `jagc auth providers --json`, `jagc model list|get|set`, and `jagc thinking get|set` implemented.
   - Stable JSON fields `run_id`, `status`, `output`, `error` implemented.
3. [x] Threading/concurrency semantics
   - Per-thread pi session reuse + queued delivery via `streamingBehavior` implemented.
   - Same-thread run completion is attributed via pi session event boundaries (not prompt promise timing).
   - DBOS-backed durable run scheduling/recovery implemented.
   - Durable `thread_key -> session` mapping is persisted in Postgres (`thread_sessions`).
   - Strict global one-active-run-per-thread guard is enforced via DBOS partitioned queueing (`jagc_runs`, `queuePartitionKey=thread_key`, per-partition concurrency=1).
4. [x] Telegram polling adapter
   - grammY polling adapter implemented for personal chats.
   - Telegram thread mapping: `thread_key = telegram:chat:<chat_id>`.
   - Telegram UX controls implemented as button-based pickers: `/settings`, `/model`, `/thinking` (`/steer` explicit opt-in).
5. [~] Feedback loop + release gate
   - Fast smoke script implemented: `pnpm smoke` and `JAGC_RUNNER=pi pnpm smoke`.
   - CI merge gating not wired yet (local gate command exists: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`).

Definition of done for v0: CLI and Telegram both work end-to-end. `jagc message "ping" --json` returns a valid `run_id`, waiting yields terminal status plus output, same-thread queue behavior is correct, Telegram polling replies in personal chats, and button-based `/settings` + `/model` + `/thinking` controls work in Telegram (with model/thinking controls also available in CLI).
