-- Photos waiting to be culled on the phone, and the marks made there.
CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  dir        TEXT NOT NULL,
  label      TEXT NOT NULL,
  name       TEXT NOT NULL,
  at         TEXT,
  state      TEXT NOT NULL DEFAULT 'unreviewed',
  marked_ms  INTEGER,
  synced_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS photos_by_dir ON photos (dir, state, at);
CREATE INDEX IF NOT EXISTS photos_marked ON photos (marked_ms);
