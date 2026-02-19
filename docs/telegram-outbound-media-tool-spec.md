# Telegram outbound media tool (proposed)

Status: **implemented (v1)**  
Last updated: **2026-02-18**

Related docs:
- `docs/architecture.md`
- `docs/testing.md`

---

## 1) Goal

Add a **custom pi tool** (not a workspace extension) that lets the agent send files directly to the active Telegram user/thread.

Primary outcomes:
- Send screenshots/pictures as Telegram photos.
- Send documents/files as Telegram documents.
- When multiple photos are sent, use Telegram media groups (albums) with correct limits.
- Tool is available **only** in Telegram sessions/threads.

---

## 2) Non-goals (v1)

- No tool exposure for non-Telegram threads.
- No destination override (`chat_id` / `message_thread_id` are not user-provided).
- No support for audio/video/animation-specific methods in v1 (`sendAudio`, `sendVideo`, `sendAnimation`).
- No transactional rollback across multiple Telegram calls.

---

## 3) External constraints (Telegram)

Use current Bot API constraints (verify during implementation):
- `sendMediaGroup` supports **2..10** items.
- Media groups can contain `photo/video` mixed, but `document` groups are document-only; for v1 we only group photos.
- `sendPhoto` caption max: 1024 chars.
- `sendDocument` caption max: 1024 chars.
- `retry_after` must be honored for `429` flood control responses.

Sources:
- https://core.telegram.org/bots/api#sendmediagroup
- https://core.telegram.org/bots/api#sendphoto
- https://core.telegram.org/bots/api#senddocument
- https://core.telegram.org/bots/api#responseparameters
- https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this

---

## 4) Tool contract

### 4.1 Name

`telegram_send_files`

### 4.2 Availability

Register this tool only when all are true:
1. `threadKey` parses as Telegram route (`telegram:chat:<id>[:topic:<id>]`).
2. Telegram bot token is configured.

Otherwise, do not register tool.

### 4.3 Input schema (v1)

```json
{
  "files": [
    {
      "path": "relative/or/absolute/path",
      "kind": "auto | photo | document",
      "caption": "optional caption <= 1024"
    }
  ],
  "caption_mode": "per_file | first_only"
}
```

Rules:
- `files` required, 1..50 items.
- `path` required; resolve relative paths against `workspaceDir`.
- `kind=auto`:
  - if mime is jpeg/png/webp and file size <= `sendPhoto` limit, classify as `photo`.
  - else classify as `document`.
- `caption_mode` default: `per_file`.

### 4.4 Output schema

```json
{
  "ok": true,
  "route": { "chat_id": 123, "message_thread_id": 456 },
  "sent": {
    "photo_groups": 1,
    "photos": 4,
    "documents": 2
  },
  "items": [
    {
      "path": "...",
      "kind": "photo|document",
      "status": "sent",
      "telegram_message_id": 1001
    }
  ]
}
```

On failure, return `ok=false` + `error_code` + `error_message` + partial `sent/items` progress.

---

## 5) Delivery algorithm (deterministic)

Given validated inputs:
1. Resolve + stat + classify files.
2. Partition into:
   - `photos[]`
   - `documents[]`
3. Send in strict order:
   - photos first
   - documents second
4. Photo sending:
   - if `photos.length === 1`: `sendPhoto`
   - if `photos.length >= 2`: chunk by 10 and call `sendMediaGroup` for each chunk
   - for final chunk of size 1 (possible when total photos mod 10 == 1): send with `sendPhoto`
5. Document sending:
   - send each with `sendDocument` (sequential in v1).
6. Retry policy:
   - wrap each Telegram API call with existing `retry_after` handling.
7. Return structured send summary.

Rationale: preserves a simple user-visible ordering: visual media first, then files.

---

## 6) Edge cases / expected behavior

- **Non-Telegram thread**: tool is absent.
- **Missing/unreadable file**: fail before any API call for that file; include actionable path error.
- **Unsupported/ambiguous mime in `auto`**: fallback to document.
- **Photo over photo size limit**: auto-downgrade to document if within document limit; else fail.
- **Caption >1024**: truncate by default in v1 and include warning in tool result.
- **Mixed photo+document input**: always photos (grouped) first, then documents.
- **429 / retry_after**: wait and retry; if attempts exhausted, return partial failure.
- **Topic thread id = 1**: normalize to base chat route (existing behavior).
- **Partial success**: previously sent items are not rolled back.

---

## 7) Integration points (implementation plan)

Minimal code shape:
- `src/runtime/pi-executor.ts`
  - Extend `PiExecutorOptions` with Telegram tool deps (`botToken`, optional `telegramApiRoot`).
  - Build `customTools` dynamically per `threadKey`.
- `src/runtime/telegram-send-files-tool.ts` (new)
  - Tool definition + input/output validation.
  - Route derivation from `threadKey`.
- `src/runtime/telegram-api-client.ts` (new)
  - thin sender wrappers: `sendPhoto`, `sendMediaGroup`, `sendDocument` + retry.
  - shared payload shaping with `message_thread_id` normalization.

Keep it runtime-local (no `defaults/extensions/*` changes).

---

## 8) Feedback loop and tests

### Fast loop
- Unit-test classifier/chunker/validation without pi runtime.
- Unit-test `sendMediaGroup` chunking and ordering.

### Telegram behavioral loop
- Extend clone (`tests/helpers/telegram-bot-api-clone.ts`) with:
  - `sendPhoto`
  - `sendMediaGroup`
- Add integration tests:
  - tool unavailable on non-Telegram thread.
  - single photo -> `sendPhoto`.
  - 2..10 photos -> one `sendMediaGroup`.
  - >10 photos -> multiple groups (+ singleton remainder via `sendPhoto`).
  - mixed photos+documents -> photos first then docs.
  - retry-after flow returns success/failure as expected.

Canonical commands:
- `pnpm test:telegram`
- `pnpm test`

---

## 9) Rollout / rollback

Rollout:
1. Ship behind registration guard (Telegram threads only).
2. Validate in local Telegram clone + real Telegram smoke.
3. Update `README.md`, `docs/architecture.md`, `docs/testing.md`, and `CHANGELOG.md` with final behavior.

Rollback:
- Disable tool registration in `PiRunExecutor` (single switch), leaving existing Telegram delivery unchanged.
