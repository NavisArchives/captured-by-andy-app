-- Clean up: the last look at rejected photos (delete or keep), and a record of
-- every deletion, so it can be undone while the Bin still has the files.
CREATE TABLE cleanup_marks (
  photo_id  TEXT PRIMARY KEY REFERENCES photos (id) ON DELETE CASCADE,
  mark      TEXT NOT NULL CHECK (mark IN ('delete', 'keep')),
  marked_ms INTEGER NOT NULL
);

-- One row per file sent to the Bin. The photo's own row is gone from the
-- library by then; what's here is enough to put it back.
CREATE TABLE deletions (
  id           INTEGER PRIMARY KEY,
  batch        TEXT NOT NULL,
  trip         TEXT NOT NULL,
  photo_id     TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  original     TEXT NOT NULL,
  binned       TEXT NOT NULL,
  size         INTEGER NOT NULL,
  is_primary   INTEGER NOT NULL,
  stem         TEXT NOT NULL,
  captured_at  TEXT NOT NULL,
  review_state TEXT NOT NULL,
  deleted_ms   INTEGER NOT NULL,
  restored_ms  INTEGER,
  phone_id     TEXT,             -- the same photo in Apple Photos, once found
  phone_state  TEXT              -- 'found', 'deleted', 'cancelled', 'not_found'
);
CREATE INDEX deletions_batch ON deletions (batch);
