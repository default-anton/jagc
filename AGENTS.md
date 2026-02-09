# Rules you must follow in this project

## Start here

- Read `README.md` first for the current operator-facing contract.
- Read `docs/architecture.md` for implemented behavior. Treat `docs/future.md` as historical/deferred notes.
- Read `docs/testing.md` for canonical test loops (especially Telegram behavioral clone coverage).
- Run `mise install` at repo root when tools are missing or after `.tool-versions` changes.
- If `mise install` fails, follow `docs/tooling.md`.

## Use canonical feedback loop commands (no ad-hoc replacements)

- Fast end-to-end smoke (echo runner): `pnpm smoke`
- Smoke through real pi runtime: `JAGC_RUNNER=pi pnpm smoke`
- Full non-smoke test suite (includes Telegram behavioral clone tests): `pnpm test`
- Focused Telegram loop (optional while iterating): `pnpm test:telegram`
- Local release gate before handoff: `pnpm release:gate`

## Non-obvious invariants (do not change accidentally)

- v0 scope includes server + CLI + Telegram polling (personal chats).
- `output` is a structured payload contract (not plain-text-only).
- Default same-thread delivery mode is `followUp`; `steer` is explicit opt-in.
- Same-thread turn ordering (`followUp` / `steer`) is enforced by the per-thread pi session controller (single-process scope in v0; global multi-process locking is deferred).
- SQLite run state defaults to `$JAGC_WORKSPACE_DIR/jagc.sqlite`; keep workspace `.gitignore` SQLite entries (`jagc.sqlite*`) intact.
- Provider/model/thinking state lives in pi settings/session state; do not duplicate model/thinking state in jagc DB.
- Local CLI usage is unauthenticated; webhook ingress requires token auth.
- Primary runtime integration is pi SDK in-process (`createAgentSession`); RPC is optional/non-primary.

## Non-obvious code locations

- `src/runtime/thread-run-controller.ts` — per-thread run coordination and event-based completion attribution.
- `src/server/{scheduler,service}.ts` — durable enqueue/recovery and run state transitions.
- `src/runtime/pi-executor.ts` + `migrations/002_thread_sessions.sql` — persisted `thread_key -> session` mapping.
- `src/adapters/telegram-runtime-controls.ts` + `src/adapters/telegram-controls-callbacks.ts` — Telegram button controls + callback payload contract.
- `scripts/smoke.sh` — canonical end-to-end contract assertions.
- `deploy/` — draft assets only; not a supported install path.

## Docs update rule

- If behavior/contracts change, update `README.md` and `docs/architecture.md` in the same change.
- If test feedback loops change, update `docs/testing.md` in the same change.
- Keep this file terse; move niche instructions to subtree `AGENTS.md` files.
