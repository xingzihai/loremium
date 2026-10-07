CREATE TABLE IF NOT EXISTS ip_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 100,
  concurrency INTEGER,
  rules       TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ip_group_members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   TEXT NOT NULL,
  value      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'ip',
  created_at INTEGER NOT NULL,
  UNIQUE(group_id, value)
);

CREATE INDEX IF NOT EXISTS idx_ip_group_members_value ON ip_group_members(value);
