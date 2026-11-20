-- Recently deleted (NIRMATA, after 8 posts went missing on 19 Nov): a deleted
-- post, album, idea or project is moved here with everything hanging off it
-- (its picture links, look, saves, media), kept 30 days, and can be restored.
-- Additive only: no existing table changes.
CREATE TABLE trash (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('post', 'album', 'idea', 'project')),
  item_id     TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  deleted_ms  INTEGER NOT NULL,
  source      TEXT NOT NULL,
  data        TEXT NOT NULL            -- JSON: {"table": [row, …], …}
);
CREATE INDEX trash_by_kind ON trash (kind, deleted_ms DESC);

-- Every delete, restore and purge of those four kinds, kept for good.
CREATE TABLE audit_log (
  id       INTEGER PRIMARY KEY,
  at_ms    INTEGER NOT NULL,
  action   TEXT NOT NULL CHECK (action IN ('delete', 'restore', 'purge')),
  kind     TEXT NOT NULL,
  item_id  TEXT NOT NULL,
  title    TEXT NOT NULL DEFAULT '',
  source   TEXT NOT NULL
);
CREATE INDEX audit_log_by_time ON audit_log (at_ms DESC);
