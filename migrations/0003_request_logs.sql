CREATE TABLE IF NOT EXISTS request_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    INTEGER NOT NULL,
  key_id        TEXT,
  ip            TEXT NOT NULL,
  model         TEXT NOT NULL,
  profile       TEXT,
  status        INTEGER NOT NULL DEFAULT 0,
  finish_reason TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  ttft_ms       INTEGER NOT NULL DEFAULT 0,
  is_stream     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_request_logs_key ON request_logs(key_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_ip ON request_logs(ip, id DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at);
