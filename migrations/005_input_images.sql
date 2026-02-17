ALTER TABLE message_ingest ADD COLUMN payload_hash TEXT;

CREATE TABLE IF NOT EXISTS input_images (
  input_image_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  user_key TEXT,
  run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE,
  telegram_media_group_id TEXT,
  mime_type TEXT NOT NULL,
  filename TEXT,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  image_bytes BLOB NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS input_images_run_position_idx
  ON input_images (run_id, position, input_image_id);

CREATE INDEX IF NOT EXISTS input_images_scope_position_idx
  ON input_images (source, thread_key, user_key, run_id, position, input_image_id);

CREATE INDEX IF NOT EXISTS input_images_expires_idx
  ON input_images (expires_at);
