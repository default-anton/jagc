# Rules you must follow in this project

## Start here

- Keep the operator-facing contract in mind: Telegram is primary UX; CLI/API are for setup, control, and debugging.
- Read `docs/architecture.md` when changing implemented behavior.
- Read `docs/testing.md` when changing test loops or validating Telegram behavioral clone coverage.
- Read `docs/release.md` before cutting/publishing releases.
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
- `deploy/` — manual launchd/systemd templates; CLI service commands are the primary supported operator path.

## Docs update rule

- If behavior/contracts change, update `README.md` and `docs/architecture.md` in the same change.
- If test feedback loops change, update `docs/testing.md` in the same change.
- Any change that modifies runtime/packaging/CLI behavior (tests/docs-only changes excluded) must add an entry to `CHANGELOG.md` under **[Unreleased]** in the same change.
- If the jagc CLI command surface changes (add/remove/rename commands or command groups), update the runtime CLI guidance in `defaults/extensions/20-runtime-harness-context.ts` in the same change.
- This repo has `AGENTS.md` in subtrees. Keep this file terse; move niche instructions to subtree `AGENTS.md` files.
