-- Slice 1: sources, photos, assets, scan runs, settings.
-- Identity is a UUIDv7 per row, never a path. Times ending in _ms are Unix
-- milliseconds; captured_at is local wall-clock text so it sorts as written.

CREATE TABLE sources (
  id                    TEXT PRIMARY KEY,
  path                  TEXT NOT NULL UNIQUE,
  label                 TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1,
  last_scan_started_ms  INTEGER,
  last_scan_finished_ms INTEGER,
  created_ms            INTEGER NOT NULL
);

CREATE TABLE photos (
  id                 TEXT PRIMARY KEY,
  review_state       TEXT NOT NULL DEFAULT 'unreviewed'
                     CHECK (review_state IN ('unreviewed', 'selected', 'maybe', 'rejected')),
  reviewed_ms        INTEGER,
  media_kind         TEXT NOT NULL CHECK (media_kind IN ('raw', 'image', 'raw_image')),
  captured_at        TEXT NOT NULL,
  captured_at_source TEXT NOT NULL CHECK (captured_at_source IN ('exif', 'file')),
  camera_make        TEXT,
  camera_model       TEXT,
  width              INTEGER,
  height             INTEGER,
  orientation        INTEGER,
  latitude           REAL,
  longitude          REAL,
  thumb_state        TEXT NOT NULL DEFAULT 'pending'
                     CHECK (thumb_state IN ('pending', 'ready', 'failed', 'unavailable')),
  thumbhash          BLOB,
  created_ms         INTEGER NOT NULL,
  updated_ms         INTEGER NOT NULL
);

CREATE INDEX photos_by_date        ON photos (captured_at DESC, id DESC);
CREATE INDEX photos_by_review_date ON photos (review_state, captured_at DESC, id DESC);
CREATE INDEX photos_thumb_pending  ON photos (thumb_state) WHERE thumb_state = 'pending';

CREATE TABLE assets (
  id                 TEXT PRIMARY KEY,
  photo_id           TEXT NOT NULL REFERENCES photos (id),
  source_id          TEXT NOT NULL REFERENCES sources (id),
  path               TEXT NOT NULL UNIQUE,
  dir                TEXT NOT NULL,
  stem               TEXT NOT NULL,   -- lower-cased file stem, for RAW+JPEG pairing
  filename           TEXT NOT NULL,
  format             TEXT NOT NULL,
  is_raw             INTEGER NOT NULL,
  is_primary         INTEGER NOT NULL DEFAULT 0,
  size               INTEGER NOT NULL,
  mtime_ms           INTEGER NOT NULL,
  fingerprint        TEXT,            -- NULL while the file is iCloud-only
  captured_at        TEXT,
  captured_at_source TEXT,
  storage_state      TEXT NOT NULL
                     CHECK (storage_state IN ('local', 'cloud_only', 'missing', 'downloading', 'available_offline')),
  last_seen_scan     INTEGER NOT NULL,
  created_ms         INTEGER NOT NULL,
  updated_ms         INTEGER NOT NULL
);

CREATE INDEX assets_photo       ON assets (photo_id);
CREATE INDEX assets_fingerprint ON assets (fingerprint) WHERE fingerprint IS NOT NULL;
CREATE INDEX assets_pairing     ON assets (dir, stem);
CREATE INDEX assets_source_seen ON assets (source_id, last_seen_scan);

CREATE TABLE scan_runs (
  id          INTEGER PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES sources (id),
  started_ms  INTEGER NOT NULL,
  finished_ms INTEGER,
  status      TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'offline')),
  discovered  INTEGER NOT NULL DEFAULT 0,
  added       INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  moved       INTEGER NOT NULL DEFAULT 0,
  unchanged   INTEGER NOT NULL DEFAULT 0,
  cloud_only  INTEGER NOT NULL DEFAULT 0,
  missing     INTEGER NOT NULL DEFAULT 0,
  errors      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
