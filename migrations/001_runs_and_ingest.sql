CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  user_key TEXT,
  delivery_mode TEXT NOT NULL DEFAULT 'followUp' CHECK (delivery_mode IN ('steer', 'followUp')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  input_text TEXT NOT NULL,
  output TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS message_ingest (
  source TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (source, idempotency_key)
);

CREATE INDEX IF NOT EXISTS runs_thread_status_idx ON runs (thread_key, status);
CREATE INDEX IF NOT EXISTS runs_created_at_idx ON runs (created_at);
