# Testing strategy

## Database feedback loop (SQLite)

DB-backed tests use `tests/helpers/sqlite-test-db.ts`:

- one in-memory SQLite database per test file
- migrations applied once in `beforeAll`
- table reset (`DELETE`) before each test for deterministic isolation
- no transactional test harness (`BEGIN/ROLLBACK`) and no external DB process

This keeps tests fast, parallel-friendly, and hermetic under Vitest worker file parallelism.

## Telegram adapter feedback loop

Telegram tests use a local behavioral Bot API clone (`tests/helpers/telegram-bot-api-clone.ts`) instead of manual `grammY` context mocks.

Primary coverage lives in:

- shared harness: `tests/helpers/telegram-test-kit.ts` (common bot token/chat fixtures, adapter+clone lifecycle helper, thread control fake)
- `tests/telegram-polling-message-flow.test.ts` (plain text, `/steer`, progress panel + typing indicator behavior, completion states, timeout/background completion handoff, long-output chunking, and adapter-level recovery from transient polling errors)
- `tests/telegram-runtime-controls.test.ts` (settings/model/thinking/auth callback flows)
- `tests/telegram-polling.test.ts` (command/callback parsing and stale callback recovery)
- `tests/telegram-bot-api-clone.test.ts` (clone contract edges: `allowed_updates`/offset semantics, transient `getUpdates` error retry compatibility (`500`/`429 retry_after`), malformed payload handling, and urlencoded payload parsing)
- `tests/telegram-system-smoke.test.ts` (system-level smoke: real run service + scheduler + SQLite + Fastify app + polling adapter + clone)

This clone is intentionally narrow: it only implements the polling and messaging surface that jagc uses in v0:

- `getMe`
- `getUpdates` (including `offset`, `limit`, `allowed_updates`, and long-poll timeout behavior)
- `sendMessage`
- `editMessageText`
- `sendChatAction`
- `answerCallbackQuery`

### Why

The goal is to test real adapter behavior through grammY's network stack and long-polling loop, not private handler internals.

That gives us stable refactors and catches protocol-shape regressions that context stubs cannot.

### Scope rules for the clone

- Keep this clone a **contract clone**, not a full Telegram reimplementation.
- Only add Bot API methods when jagc starts using them.
- Keep method behavior deterministic and assertion-friendly.
- Record outbound bot calls so tests assert on real API payloads (`text`, `reply_markup.inline_keyboard`, callback answers).
- Accept both JSON and `application/x-www-form-urlencoded` Bot API payloads (including JSON-encoded nested fields like `reply_markup`) to stay resilient to client transport changes.
- Fail loud on malformed request payloads (invalid JSON or invalid `getUpdates` argument shapes) to avoid silent transport bugs in tests.

### Commands

- Full non-smoke suite (includes Telegram behavioral tests): `pnpm test`
- Focused Telegram suite (optional while iterating, includes Telegram system smoke): `pnpm test:telegram`
- Local release gate: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
