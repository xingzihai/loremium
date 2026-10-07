CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  model_id   TEXT NOT NULL UNIQUE,
  program    TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  window_seconds INTEGER NOT NULL,
  limit_chars    INTEGER NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  note           TEXT
);

CREATE TABLE IF NOT EXISTS ip_overrides (
  ip          TEXT PRIMARY KEY,
  concurrency INTEGER,
  rules       TEXT,
  expires_at  INTEGER,
  note        TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  key_prefix    TEXT NOT NULL,
  quota_mode    TEXT NOT NULL DEFAULT 'unlimited'
                CHECK (quota_mode IN ('unlimited','per_ip','total')),
  quota_rules   TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  expires_at    INTEGER,
  note          TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

INSERT OR IGNORE INTO config (key, value, updated_at) VALUES
  ('first_delay_ms', '300', 0),
  ('chars_per_second', '30', 0),
  ('chunk_size', '4', 0),
  ('max_duration_s', '120', 0),
  ('max_output_chars', '32000', 0),
  ('concurrency_limit', '2', 0),
  ('over_limit_behavior', 'truncate', 0),
  ('default_model', 'loremium-unicode', 0),
  ('strict_model', 'false', 0),
  ('cors_origin', '*', 0),
  ('auth_mode', 'optional', 0);


INSERT OR IGNORE INTO profiles (id, name, model_id, program, is_default, enabled, updated_at) VALUES
  ('p_unicode', 'Unicode 乱码', 'loremium-unicode',
   '{"type":"sequence","children":[{"type":"charset","pool":"unicode-garbage","min":12,"max":40},{"type":"text","value":"\n"},{"type":"charset","pool":{"range":["U+E000","U+F8FF"]},"min":6,"max":16}]}',
   1, 1, 0),
  ('p_lorem', 'Lorem 占位', 'loremium-lorem',
   '{"type":"repeat","times":{"min":2,"max":4},"children":[{"type":"lorem","words":{"min":8,"max":16},"capitalize":true},{"type":"text","value":". "}]}',
   0, 1, 0),
  ('p_fixed', '固定文本', 'loremium-fixed',
   '{"type":"sequence","children":[{"type":"text","value":"Lorem ipsum dolor sit amet, consectetur adipiscing elit."}]}',
   0, 1, 0);
