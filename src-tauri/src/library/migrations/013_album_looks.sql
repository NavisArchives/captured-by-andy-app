-- An album's own look: the edit (look, strength, sliders; never the framing)
-- its photos are meant to share. Set on purpose; changing it updates the
-- photos still exactly on it.
CREATE TABLE album_looks (
  album_id    TEXT PRIMARY KEY REFERENCES albums (id) ON DELETE CASCADE,
  look_id     TEXT REFERENCES looks (id) ON DELETE SET NULL,
  strength    REAL NOT NULL DEFAULT 1.0,
  adjustments TEXT NOT NULL DEFAULT '{}',
  updated_ms  INTEGER NOT NULL
);
