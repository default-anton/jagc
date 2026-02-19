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

- provider-agnostic scheduled task coverage:
  - `tests/scheduled-task-store.test.ts` (scheduled task schema/index/constraint invariants)
  - `tests/scheduled-task-service.test.ts` (due dispatch, recurring advancement, pending/dispatched recovery)
  - `tests/server-api.test.ts` (task CRUD + run-now API contract)
  - `tests/cli-task-commands.test.ts` and `tests/cli-client.test.ts` (task CLI surface + client bindings)
- shared Telegram harness: `tests/helpers/telegram-test-kit.ts` (common bot token/chat fixtures, adapter+clone lifecycle helper, thread control fake)
- `tests/telegram-polling-message-flow.test.ts` (plain text, `/steer`, topic-thread key mapping, topic-aware delivery payloads, append-log progress + typing indicator behavior, `>`/`~` stream rendering, tool-argument snippet rendering, completion states, no-timeout long-run delivery, entity-based Markdown terminal rendering, language-aware code attachments, progress overflow splitting into additional Telegram messages, long-output chunking, and adapter-level recovery from transient polling errors)
- `tests/telegram-runtime-controls.test.ts` (settings/model/thinking/auth callback flows, including topic-thread `/new`/callback scoping)
- `tests/telegram-polling.test.ts` (command/callback parsing and stale callback recovery)
- `tests/telegram-bot-api-clone.test.ts` (clone contract edges: `allowed_updates`/offset semantics, transient `getUpdates` error retry compatibility (`500`/`429 retry_after`), topic API support (`createForumTopic`), malformed payload handling, urlencoded payload parsing, and multipart `sendDocument`/`sendPhoto`/`sendMediaGroup` payload parsing)
- `tests/telegram-send-files-tool.test.ts` (Telegram custom tool behavior: single-photo send, photo media-group chunking, >10 photo split, mixed photo+document ordering, and retry-after handling)
- `tests/telegram-markdown.test.ts` (Markdown AST-to-entity rendering, entity-safe chunking, language-aware code attachment filename mapping, and a small fixture corpus of realistic messy LLM markdown inputs)
- `tests/telegram-system-smoke.test.ts` (system-level smoke: real run service + scheduler + scheduled-task service + SQLite + Fastify app + polling adapter + clone)
- `tests/cli-service-manager.test.ts` (launchd service-manager helpers: plist rendering, server entrypoint resolution, launchctl output parsing)
- `tests/session-custom-tools.test.ts` (session tool-registration guards, including Telegram-only tool availability)

This clone is intentionally narrow: it only implements the polling and messaging surface that jagc uses in v0:

- `getMe`
- `getUpdates` (including `offset`, `limit`, `allowed_updates`, and long-poll timeout behavior)
- `createForumTopic`
- `editForumTopic`
- `sendMessage`
- `editMessageText`
- `sendChatAction`
- `deleteMessage`
- `answerCallbackQuery`
- `sendPhoto`
- `sendMediaGroup`
- `sendDocument`

### Why

The goal is to test real adapter behavior through grammY's network stack and long-polling loop, not private handler internals.

That gives us stable refactors and catches protocol-shape regressions that context stubs cannot.

### Scope rules for the clone

- Keep this clone a **contract clone**, not a full Telegram reimplementation.
- Only add Bot API methods when jagc starts using them.
- Keep method behavior deterministic and assertion-friendly.
- Record outbound bot calls so tests assert on real API payloads (`text`, `reply_markup.inline_keyboard`, callback answers).
- Accept JSON, `application/x-www-form-urlencoded`, and multipart/form-data Bot API payloads (including JSON-encoded nested fields like `reply_markup`) to stay resilient to client transport changes.
- Fail loud on malformed request payloads (invalid JSON or invalid `getUpdates` argument shapes) to avoid silent transport bugs in tests.

### Commands

- Fast end-to-end smoke (echo runner): `pnpm smoke`
- Full non-smoke suite (includes Telegram behavioral tests): `pnpm test`
- Focused Telegram suite (optional while iterating, includes Telegram system smoke): `pnpm test:telegram`
- npm package smoke (pack + install + run from tarball): `pnpm test:pack`
- macOS launchd service smoke (manual): `jagc install --runner echo --port <port> && jagc status && jagc doctor && jagc uninstall`
- Local release gate: `pnpm release:gate` (equivalent to `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:pack`)
