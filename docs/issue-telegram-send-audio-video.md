# GitHub issue draft — `telegram_send_files`: add `sendAudio` / `sendVideo` with Telegram-aware constraints

## Title

`telegram_send_files`: first-class audio/video delivery (`sendAudio` / `sendVideo`) with Telegram constraint-aware routing

## Body

### Problem

`telegram_send_files` currently supports only `photo` and `document`. Audio/video outputs are sent as `sendDocument`, which hurts Telegram UX (no native music/video player behavior).

### Goal

Enable jagc to send playable audio/video in Telegram while staying strict about Telegram Bot API constraints, predictable fallbacks, and existing tool ergonomics.

### Scope

Primary implementation files:

- `src/runtime/telegram-send-files-core.ts`
- `src/runtime/telegram-send-files-tool.ts`

Required test/docs updates:

- `tests/telegram-send-files-tool.test.ts`
- `tests/helpers/telegram-bot-api-clone.ts`
- `README.md`
- `docs/architecture.md`
- `docs/testing.md`
- `CHANGELOG.md` (`[Unreleased]`)

---

## Telegram constraints to encode (must be explicit in implementation)

From Bot API (early 2026):

1. **Cloud Bot API upload limits**
   - multipart upload: **50 MB for non-photo files** (audio/video/document)
   - current jagc file cap is already 50 MB; keep this cap for predictability

2. **Format constraints**
   - `sendAudio`: audio should be **.MP3 or .M4A**
   - `sendVideo`: Telegram clients support **MPEG-4 video**; other formats may be sent as `Document`

3. **Caption constraints**
   - media captions are **0–1024 chars after entity parsing**
   - jagc already truncates to 1024; keep behavior unchanged

4. **Thumbnails**
   - optional and constrained (JPEG, <200 KB, <=320x320)
   - out of scope for this issue (no thumbnail generation/upload in v1)

5. **Rate limits / retries**
   - Telegram can return 429 with `retry_after`
   - existing retry wrapper must apply to `sendAudio` and `sendVideo` as well

6. **Local Bot API server note**
   - local Bot API can upload up to 2000 MB, but jagc should keep a stable 50 MB cap in this issue

---

## Proposed behavior

### 1) Extend `kind` enum

From:

- `auto | photo | document`

To:

- `auto | photo | video | audio | document`

### 2) Routing/classification rules

Keep routing deterministic and conservative:

- `photo`: existing magic-byte + size checks
- `video`: only when file extension is `.mp4` (conservative MPEG-4 routing)
- `audio`: only when extension is `.mp3` or `.m4a`
- otherwise: `document`

For **explicit** `kind: "audio" | "video"` requests that don’t pass safe format checks, **downgrade to `document` with warning** (same DX pattern as current explicit `photo` downgrade behavior).

### 3) Send methods

- `photo` → existing `sendPhoto` / `sendMediaGroup`
- `video` → `sendVideo`
- `audio` → `sendAudio`
- `document` → existing `sendDocument`

### 4) Outgoing order

Deterministic and media-first:

- photos (grouped), then videos, then audios, then documents

### 5) Result contract updates (additive)

- `SendKind`, `PreparedFile.kind`, `ItemResult.kind` include `audio` and `video`
- `ToolResultDetails.sent` gains:
  - `videos`
  - `audios`

### 6) Caption behavior

No semantic change:

- existing trim/truncate behavior remains
- `caption_mode=first_only` still applies across **full outgoing order**

---

## Non-goals

- `sendVoice` / `sendVideoNote`
- thumbnail extraction/generation/upload
- ffmpeg/transcoding/remuxing
- lifting >50 MB cap (including local-Bot-API-specific branching)
- audio/video media-group batching in this iteration

---

## Acceptance criteria

1. `kind: "video"` uses `sendVideo`; success increments `sent.videos`.
2. `kind: "audio"` uses `sendAudio`; success increments `sent.audios`.
3. `kind: "auto"` routes only safe formats to video/audio; all other files fallback to document.
4. Explicit unsupported `kind: "audio" | "video"` downgrades to document + warning (no silent failure).
5. Existing photo behavior stays unchanged:
   - 1 photo → `sendPhoto`
   - 2..10 photos → `sendMediaGroup`
   - >10 photos chunking unchanged
6. Mixed payload ordering is deterministic: photos → videos → audios → documents.
7. 429 retry behavior works for `sendAudio`/`sendVideo` (`retry_after` path).
8. Tool JSON remains backward-compatible (additive fields only).

---

## Test plan

Use canonical loops:

- `pnpm test:telegram`
- `pnpm test`

Add/extend tests for:

- explicit video send path (`sendVideo`)
- explicit audio send path (`sendAudio`)
- `auto` routing for supported audio/video extensions
- unsupported explicit audio/video downgrade-to-document warnings
- mixed-kind ordering across photos/videos/audios/documents
- retry-after behavior for `sendVideo` and/or `sendAudio`

Extend Telegram Bot API clone with:

- `sendAudio`
- `sendVideo`

---

## DX/UX guardrails

- Keep tool surface additive and unsurprising.
- Preserve safe fallback to `document` for ambiguous/unsupported media.
- Keep errors actionable (`failed to send audio ...`, `failed to send video ...`).
