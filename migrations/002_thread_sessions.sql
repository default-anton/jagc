CREATE TABLE IF NOT EXISTS thread_sessions (
  thread_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  session_file TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS thread_sessions_session_id_idx ON thread_sessions (session_id);
