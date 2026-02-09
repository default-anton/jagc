# jagc future (deferred + historical notes)

This file is intentionally short.

- **Current behavior/contracts** live in [`README.md`](../README.md) and [`docs/architecture.md`](./architecture.md).
- This file tracks only **post-v0 priorities** and a few **historical decisions** worth keeping visible.
- Removed pre-v0 draft detail can be recovered from git history if needed.

## v0 shipped baseline (context only)

v0 is shipped as pre-alpha with:

- Server: `/healthz`, `/v1/messages`, `/v1/runs/:run_id`, auth endpoints, model/runtime controls.
- CLI: `health`, `message`, `run wait`, auth/model/thinking commands, and macOS service lifecycle (`install|status|restart|uninstall|doctor`).
- Runtime: pi SDK in-process sessions with SQLite-backed run state + in-process scheduling.
- Concurrency: in-process dispatch + per-thread pi session turn control (`followUp` / `steer`); multi-process/global locking deferred.
- Telegram: polling adapter for personal chats + button-based `/settings` `/model` `/thinking` `/auth`.

Do not add implementation detail here unless it is deferred/future-looking.

## Post-v0 priorities

### P1 — high leverage

1. **Webhook hardening**
   - Keep bearer-token baseline.
   - Add per-source signature verification where available.
   - Add replay protection (timestamp + nonce window).

2. **Release hardening follow-ups**
   - Add automated policy checks for changelog section quality/content.
   - Add optional staged/canary release flow before promoting to `latest`.

### P2 — operator/developer UX

1. **`jagc workspace init`** for quick workspace scaffolding.
2. **Explicit integration test target** (e.g., `pnpm test:integration`) distinct from unit tests.
3. **Service logs UX** (structured tail/filter command) to reduce launchctl/manual log digging.

### P3 — deployment maturity

1. Add first-class Linux (`systemd`) and Windows (`SCM`) implementations behind the same `jagc install|status|restart|uninstall` interface.
2. Add backup/restore guidance for workspace + SQLite before risky upgrades.
3. Add one-command operator backup verification smoke before upgrades.

## Near-term non-goals

- Telegram webhook runtime mode in core (polling remains the supported Telegram mode).
- Multi-host/distributed runtime orchestration.
- New ingress adapters in core beyond current v0 scope.
- Large API surface expansion before hardening current contracts.

## Historical decisions worth preserving

- Keep `output` as a structured payload contract (not plain text only).
- Keep same-thread default delivery mode as `followUp`; `steer` is explicit.
- Keep provider/model/thinking state in pi settings/session state; do not duplicate in jagc DB.
