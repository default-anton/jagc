# Issue: Add image input support with temporary DB buffering across CLI/API/Telegram

## Summary

Add image input support to jagc end-to-end (CLI, HTTP API, runtime, Telegram) using **temporary SQLite storage** in a new `input_images` table.

This issue locks the implementation details so we can ship without ambiguity:

- images are **not** stored permanently in jagc run rows,
- images are deleted after successful `prompt`/`followUp`/`steer` submission into pi session,
- undelivered or leaked images expire after 3 days,
- stale cleanup runs on every new message/image ingest (no cron job),
- Telegram buffering is DB-backed only (no in-memory image buffering),
- limits are enforced consistently: max 10 images, max 50MiB decoded bytes total.

pi session durability already covers long-term image persistence, so jagc only needs temporary staging.

---

## Motivation

Current jagc ingress is text-only. pi SDK already supports images, but jagc cannot pass them through.

We need multimodal input without letting SQLite grow unbounded from image payloads. Temporary staging + strict lifecycle cleanup gives image support while keeping storage bounded.

---

## Scope

### In scope

- API contract extension for image input.
- CLI image flags and payload building.
- New `input_images` migration/table + store APIs.
- Runtime changes to pass image arrays into pi SDK (`prompt`/`followUp`/`steer`).
- Telegram image ingestion + DB-backed pending buffer + attach-on-text behavior.
- Tests + docs + changelog updates.

### Out of scope

- Any cron-based cleanup worker.
- Permanent image archival in jagc DB.
- Non-image attachment types (video/audio/etc).

---

## Locked decisions (implementation contract)

1. **API wire format (`POST /v1/messages`)**
   - `images` is optional; when present it is an ordered array of objects:
     - `mime_type: string`
     - `data_base64: string` (raw base64, no data URL prefix)
     - `filename?: string`
   - v1 allowed MIME types: `image/jpeg`, `image/png`, `image/webp`, `image/gif`.
   - Request order is preserved (`images[0]` stays first through runtime delivery).

2. **Idempotency conflict behavior**
   - Same `idempotency_key` + same canonical payload => return existing run (no duplicate image rows).
   - Same `idempotency_key` + different canonical payload (`thread_key`, `text`, `delivery_mode`, or any `images[*]`) => `409` with stable code `idempotency_payload_mismatch`.

3. **Delivery success point for image deletion**
   - A run’s staged images are deleted only after the corresponding pi call returns successfully:
     - `session.prompt(...)`
     - `session.followUp(...)`
     - `session.steer(...)`

4. **TTL policy applies to all staged rows**
   - `expires_at` applies to both pending (`run_id IS NULL`) and run-bound (`run_id IS NOT NULL`) rows.
   - Purge removes any expired rows on ingest-triggered cleanup.
   - During Telegram text ingest claim flow, claim + bind + expiry refresh happen in one transaction so claimed rows are not purged mid-claim.

5. **Telegram media-group handling**
   - No in-memory aggregation/debounce.
   - Every inbound image update is persisted immediately.
   - Rows include optional `telegram_media_group_id` for traceability.
   - Attach order on text is deterministic via persisted ordering (see schema/order rules below), so albums are replayed consistently.

6. **Cross-surface validation errors**
   - Stable codes/messages used across API/CLI/Telegram:
     - `image_count_exceeded`
     - `image_total_bytes_exceeded`
     - `image_mime_type_unsupported`
     - `image_base64_invalid`
     - `image_buffer_limit_exceeded` (Telegram pending scope)
     - `idempotency_payload_mismatch`

---

## Requirements (hard constraints)

1. **Storage model**
   - Do not add `input_images` JSON/blob columns to `runs`.
   - Add new SQLite table: `input_images`.
   - Store image bytes temporarily in this table.

2. **Lifecycle / retention**
   - Delete run-linked images immediately after successful `prompt`/`followUp`/`steer` return.
   - Delete stale images older than **3 days**.
   - No cron/scheduler for cleanup.
   - Run stale cleanup on every new:
     - message ingest,
     - image ingest.

3. **Telegram buffering**
   - Do not buffer images in memory.
   - Persist incoming Telegram images to `input_images` immediately.
   - When user later sends text, attach pending images from DB to that text/run.

4. **Limits**
   - Max images per message/run: **10**.
   - Max total decoded image payload per message/run: **50MiB**.
   - Allowed MIME types (v1): `image/jpeg`, `image/png`, `image/webp`, `image/gif`.
   - Enforce limits consistently across CLI/API/Telegram.

5. **HTTP body size**
   - Set Fastify `bodyLimit` to **75MiB** (`78643200` bytes) to absorb base64 + JSON overhead.
   - Logical 50MiB decoded-image validation remains authoritative.

6. **CLI UX**
   - Support:
     - `--image <path>`
     - `-i <path>` (short alias)
   - Example:
     - `jagc message "describe these" -i ./a.jpg -i ./b.png`

---

## Proposed storage and lifecycle model

### `input_images` table (new migration)

Suggested columns (names may vary, semantics must match):

- `input_image_id` TEXT PK
- `source` TEXT NOT NULL
- `thread_key` TEXT NOT NULL
- `user_key` TEXT NULL
- `run_id` TEXT NULL REFERENCES `runs(run_id)` ON DELETE CASCADE
- `telegram_media_group_id` TEXT NULL
- `mime_type` TEXT NOT NULL
- `byte_size` INTEGER NOT NULL CHECK (`byte_size > 0`)
- `image_bytes` BLOB NOT NULL
- `position` INTEGER NOT NULL CHECK (`position >= 0`)
- `created_at` TEXT NOT NULL
- `expires_at` TEXT NOT NULL

Recommended indexes:

- `(run_id, position, input_image_id)`
- `(source, thread_key, user_key, run_id, position, input_image_id)`
- `(expires_at)`

Ordering rules:

- API/CLI run-bound inserts: `position` follows request array order (0..n-1).
- Telegram pending inserts: assign monotonic `position` in DB scope `(source, thread_key, user_key, run_id IS NULL)` inside transaction.
- Runtime reads run-linked images ordered by `(position ASC, input_image_id ASC)`.

### Lifecycle states

1. **Pending (Telegram image-only message)**: row inserted with `run_id = NULL`.
2. **Bound to run**: pending rows claimed/updated to specific `run_id` when text arrives.
3. **Delivered**: runtime submits input to pi (`prompt`/`followUp`/`steer` success), then deletes rows for `run_id`.
4. **Expired**: any row removed when `expires_at <= now` during ingest-triggered cleanup.

Expiry refresh rule:

- On Telegram claim-to-run, refresh `expires_at = now + 3 days` for claimed rows.

---

## Behavior by surface

### HTTP API (`POST /v1/messages`)

- Extend request schema with optional `images` array.
- Keep `text` required.
- Validate:
  - image count <= 10,
  - sum(decoded bytes) <= 50MiB,
  - allowed MIME types (`image/jpeg`, `image/png`, `image/webp`, `image/gif`),
  - base64 validity.
- On ingest, create run and persist images in `input_images` linked via `run_id`.

### CLI (`jagc message`)

- Add repeatable `-i, --image <path>` option.
- Read each image file, detect/validate MIME, base64 encode for API payload.
- Enforce local validation before request where possible; server remains authoritative.
- Preserve user flag order in outgoing `images[]`.

### Telegram

#### On image-only inbound update

- Run TTL purge first.
- Persist image(s) to `input_images` as pending (`run_id = NULL`) scoped by `source=telegram`, `thread_key`, `user_key`.
- Enforce pending-buffer limits (10 images, 50MiB) for this scope.
- Reply with a short waiting message (e.g. “Saved N image(s). Send text instructions.”).

#### On text inbound update

- In one transaction:
  1. create run,
  2. claim pending images for `(source, thread_key, user_key)` in deterministic order,
  3. bind claimed rows to `run_id`,
  4. refresh claimed `expires_at` to `now + 3 days`.
- Deliver run normally.

---

## Runtime contract

- Before submitting a run to pi session, load run-linked images from `input_images`.
- Convert BLOB bytes to base64 payload expected by pi SDK.
- Pass to:
  - `session.prompt(text, { images })`
  - `session.followUp(text, images)`
  - `session.steer(text, images)`
- After that method returns successfully, delete that run’s images from `input_images`.

Notes:

- Preserve existing same-thread ordering guarantees.
- Keep deletion idempotent and retry-safe.

---

## Concurrency and correctness requirements

- Run creation + pending-image claim for Telegram text must be atomic (single transaction).
- Prevent double-claiming pending images under concurrent updates.
- Idempotent ingest must not duplicate image rows.
- Cleanup must not interfere with rows being claimed in the same transaction.
- Deterministic ordering must hold under concurrent Telegram updates for the same `(thread_key, user_key)`.

---

## Observability requirements

Add structured logs/metrics for:

- `images_ingested_count`
- `images_ingested_bytes`
- `images_claimed_count`
- `images_deleted_after_delivery_count`
- `images_purged_expired_count`
- `images_purged_expired_bound_count` (warn-level when `run_id IS NOT NULL`)

Include `source`, `thread_key`, `run_id` (when present), and reason/error code for rejects.

---

## Implementation plan (phased)

### Phase 1: API + CLI + runtime pass-through

- [ ] Add migration `005_input_images.sql` (new table + constraints + indexes).
- [ ] Extend shared API contracts/types for image input shape.
- [ ] Add store APIs:
  - [ ] persist run-bound images,
  - [ ] list run images,
  - [ ] delete run images after delivery,
  - [ ] purge expired images.
- [ ] Wire purge calls on API/CLI ingest paths.
- [ ] Update runtime submit path to include images in pi SDK calls.
- [ ] Delete run images immediately after successful delivery call return.
- [ ] Add CLI `-i/--image` options and payload construction.
- [ ] Set Fastify `bodyLimit` to 75MiB.

### Phase 2: Telegram DB-backed buffering

- [ ] Add store APIs:
  - [ ] persist pending Telegram images,
  - [ ] claim pending images to run (transactional),
  - [ ] pending-buffer limit checks by `(source, thread_key, user_key)`.
- [ ] Add Telegram image handlers (`photo` + image `document`) with immediate DB persistence.
- [ ] Attach buffered images when subsequent text is ingested.
- [ ] Ensure purge runs on Telegram image/text ingest paths.

### Cross-phase docs and release hygiene

- [ ] Add/adjust tests (unit + integration + telegram).
- [ ] Update `README.md`, `docs/architecture.md`, `docs/testing.md` (if loop changed), `CHANGELOG.md` (`[Unreleased]`).

---

## Acceptance criteria

1. `jagc message "describe" -i a.jpg -i b.png` sends images + text; runtime reaches pi with both, in order.
2. Telegram image-only messages do not start runs; bot acknowledges waiting state.
3. Telegram text after buffered images starts one run with buffered images attached in deterministic order.
4. Buffered images are stored only in `input_images` and not in `runs`.
5. Run-linked images are deleted after successful `prompt`/`followUp`/`steer` return.
6. Expired rows (pending or run-bound) older than 3 days are deleted during subsequent ingest operations.
7. No cron/scheduler job is introduced for image cleanup.
8. Limits are enforced (10 images, 50MiB decoded total) with stable actionable error codes.
9. Idempotency payload mismatch returns `409 idempotency_payload_mismatch`.
10. Existing text-only behavior remains backward compatible.

---

## Test plan (minimum)

- Store tests:
  - create/claim/delete/purge image lifecycle,
  - transactional claim correctness,
  - deterministic ordering,
  - idempotency behavior + payload mismatch conflict.
- Runtime tests:
  - images passed to `prompt/followUp/steer`,
  - deletion occurs only after successful method return.
- API tests:
  - schema validation for `images`,
  - size/count/mime/base64 validation,
  - `409 idempotency_payload_mismatch`.
- CLI tests:
  - `-i/--image` parsing,
  - payload shaping + order preservation,
  - local preflight validation behavior.
- Telegram tests:
  - image buffering with DB persistence,
  - media-group ordering behavior,
  - attach-on-text behavior,
  - TTL cleanup on ingest trigger.
- System smoke:
  - end-to-end API->run->delivery with images,
  - optional Telegram end-to-end with pending buffer.

Run canonical loops:

- `pnpm smoke`
- `JAGC_RUNNER=pi pnpm smoke` (optional real runtime loop)
- `pnpm test`
- `pnpm test:telegram`
- `pnpm release:gate`

---

## Risks / pitfalls

- Large JSON payload handling (body size + decode overhead).
- Race conditions when multiple Telegram updates arrive quickly for same thread/user.
- Deleting images too early (must only happen after successful submit call return).
- Leaking rows when run fails/cancels/crashes (mitigated by TTL + ingest-triggered purge).

---

## Rollback plan

- Keep feature behind additive schema + code paths; rollback by ignoring `images` payload and skipping Telegram image handlers.
- If needed, deploy hotfix that disables image ingest while preserving existing text path.
- Migration rollback is not required for emergency disable; table can remain unused.

---

## Open decisions (none blocking)

- If we later support non-image attachments, keep this table image-only and introduce a separate generic `input_attachments` design instead of widening v1 quickly.
