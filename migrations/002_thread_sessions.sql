CREATE TABLE IF NOT EXISTS thread_sessions (
  thread_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  session_file TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS thread_sessions_session_id_idx ON thread_sessions (session_id);
