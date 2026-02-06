# Rules you must follow in this project

- Always read README.md for context before doing anything else.
- Run `mise install` at repo root when required tools are missing or after `.tool-versions` changes.
- For `mise install` troubleshooting, read `docs/tooling.md`.

## v0 locked product decisions

- First version includes Telegram support (polling mode) in addition to server + CLI.
- `output` contract is structured payloads (not plain text only).
- Same-thread default delivery mode is `followUp`; `steer` is explicit opt-in.
- Build toward single-host production deployment from day one (keep local dev simple).
- No auth required for local CLI usage; webhook ingress must use token-based authentication.
- Provider/model/thinking selection is delegated to pi settings (do not duplicate in jagc DB).
- Telegram UX must include model/thinking controls (starting with `/model` and `/thinking`).
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

### Pi docs reviewed (absolute paths)

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

1. Server skeleton + durability
   - Implement `GET /healthz`, `POST /v1/messages`, `GET /v1/runs/:run_id`.
   - Persist run state transitions (`running|succeeded|failed`) with idempotent message ingest.
2. CLI happy path
   - Implement `jagc message "..." --json` and `jagc run wait <run_id> --json`.
   - Ensure stable JSON output fields: `run_id`, `status`, `output`.
3. Threading/concurrency semantics
   - Enforce one active run per thread key.
   - Implement queued behavior: `steer` interrupts at next tool boundary, `followUp` waits for idle.
4. Telegram polling adapter
   - Personal chats only for MVP.
   - Map chat IDs to thread keys and reuse server concurrency semantics.
5. Feedback loop + release gate
   - Add a fast smoke script that validates the MVP acceptance flow end-to-end.
   - Gate merge on: relevant tests + lint/typecheck + smoke passing.

Definition of done for v0: `jagc message "ping" --json` returns a valid `run_id`, and waiting that run yields terminal status plus output, with correct same-thread queue behavior.
