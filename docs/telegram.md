# Telegram adapter contract (polling)

This doc is the detailed behavior contract for the Telegram adapter.

## Ingest + identity mapping

- Ingest source: grammY long polling (personal chats).
- Thread mapping: `thread_key = telegram:chat:<chat_id>` for base chats, and `thread_key = telegram:chat:<chat_id>:topic:<message_thread_id>` when Telegram topic/thread context is present on inbound message/callback payloads.
- Telegram general topic (`message_thread_id=1`) is normalized to base-chat routing (no `:topic:1` key).
- User mapping: `user_key = telegram:user:<from.id>`.
- Access gate: handling is allowlisted by `JAGC_TELEGRAM_ALLOWED_USER_IDS` (`from.id` values). Empty allowlist means deny all.
- Unauthorized users receive in-chat allowlist guidance (`jagc telegram allow --user-id <id>`) and no run is ingested.

## Command + delivery behavior

- Default delivery mode for normal text messages: `followUp` (`/steer` is explicit).
- Supported commands: `/settings`, `/cancel`, `/new`, `/delete`, `/share`, `/model`, `/thinking`, `/auth`.
- Unknown slash commands are forwarded to the assistant as normal `followUp` text with original content.
- `/model` and `/thinking` use button pickers; text args are intentionally unsupported.
- After model/thinking changes, adapter returns to `/settings` and shows updated runtime state.
- Outdated/invalid callback payloads trigger stale-menu recovery by re-rendering the latest `/settings` panel.
- Telegram callback payload size is capped at 64 bytes; over-limit model/auth options are hidden and surfaced with an in-chat warning.

## Image buffering + ingest rules

- Inbound Telegram `photo` and image `document` updates are persisted immediately into `input_images` as pending rows (`run_id = NULL`) scoped by `(source='telegram', thread_key, user_key)`.
- Image-only updates do not ingest a run; adapter replies with a waiting hint.
- Pending image buffer limits are enforced per `(source, thread_key, user_key)` scope (max 10 images, max 50MiB decoded bytes), with rejection code `image_buffer_limit_exceeded`.
- Buffering is idempotent by Telegram `update_id`; replayed updates do not duplicate staged rows.
- Oversized Telegram metadata (`file_size > 50MiB`) is rejected before download (`image_total_bytes_exceeded`).
- On next text/`/steer` ingest for the same scope, run creation + pending-image claim + `expires_at` refresh happen in one DB transaction; claimed rows bind to the new `run_id` in deterministic persisted order.
- Ingest-triggered TTL purge (`expires_at <= now`) runs on both Telegram text ingest and Telegram image ingest.

## Session/runtime controls

- `/cancel`, API `POST /v1/threads/:thread_key/cancel`, and CLI `jagc cancel` abort active work for the thread without resetting session context.
- After successful Telegram `/cancel`, terminal `❌ run ... failed: This operation was aborted` reply is suppressed (explicit cancel confirmation is the terminal signal).
- `/new` and API `DELETE /v1/threads/:thread_key/session` abort/dispose the current thread session, clear persisted `thread_sessions` mapping, and force a fresh pi session on the next message.
- `/delete` (topic only) deletes current Telegram topic, aborts topic-scoped waiters, clears matching scheduled-task execution-thread bindings, and resets corresponding topic session mapping when controls are available.
- `/share` and API `POST /v1/threads/:thread_key/share` export session HTML and upload a secret GitHub gist; response includes gist URL + share-viewer URL.

## Progress + output rendering

- Adapter starts a per-run progress reporter (in-chat append-style progress message + typing indicator) as soon as a run is ingested.
- On assistant-bound inbound text (`followUp`/`steer`), adapter sends a best-effort random emoji reaction for immediate feedback.
- Progress is driven by run lifecycle events and forwarded pi session events (`assistant_text_delta`, `assistant_thinking_delta`, `tool_execution_*`, turn/agent lifecycle).
- Rendering uses compact append-log lines (`>` for tool calls, `~` for short thinking snippets); each streamed thinking content part gets its own `~` line.
- Tool completion edits the original `>` line in place with status + duration (`[✓] done (0.4s)` / `[✗] failed (0.4s)`).
- Progress send/edit uses Telegram `entities` payloads for thinking-line markdown styling; tool-call labels stay literal.
- Until first visible thinking/tool snippet, progress message shows a short single-word placeholder; once snippets arrive placeholder is removed; if none arrive by completion, placeholder message is deleted.
- Status updates are edit-throttled and retry-aware (`retry_after`).
- When progress exceeds editable message limits, older lines are flushed into additional `progress log (continued):` messages and the live message keeps tail updates.
- Adapter waits for terminal run status in background and replies with output/error when done (no timeout handoff message).

## Scheduled task topic delivery

- Scheduled task runs reuse normal run-delivery path and are delivered into Telegram topics.
- First run lazily creates a dedicated per-task topic via `createForumTopic` using task title (trimmed to Telegram limits), then persists resulting `message_thread_id` route metadata.
- Topic-thread delivery includes `message_thread_id` on sends/edits/actions/documents/progress payloads so all run updates stay inside topic.
- Task title sync (`editForumTopic`) applies only to task-owned topics; creator-origin topics are not renamed.
- Topic creation checks bot capability (`getMe().has_topics_enabled`) and returns actionable `telegram_topics_unavailable` errors when private-topic mode is disabled/unresolved.

## Formatting + file delivery

- Terminal assistant text replies are parsed as Markdown and sent via Telegram `entities` (not `parse_mode`).
- Adapter-originated command/status/auth text replies are sent as literal text to avoid markdown mutation of operator commands/path snippets.
- Fenced code blocks above inline thresholds are emitted as Telegram document uploads with language-aware filenames (for example `snippet-1.ts`); shorter blocks stay inline as `pre` entities.
- Telegram-thread pi sessions expose a `telegram_send_files` custom tool so the agent can push workspace/local files directly to active Telegram route.
- Media send ordering is deterministic: photos (`sendPhoto`/`sendMediaGroup`, 2..10), then videos (`sendVideo`), then audios (`sendAudio`), then documents (`sendDocument`).
- `auto` media routing is conservative: photo magic-byte+size checks first, then `.mp4`, then `.mp3`/`.m4a`, else document.
