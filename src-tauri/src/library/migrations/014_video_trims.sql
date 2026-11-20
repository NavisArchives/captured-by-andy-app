-- A video's trim: the part of it that is used (exports, posts). No row: the whole clip.
CREATE TABLE video_trims (
  photo_id   TEXT PRIMARY KEY REFERENCES photos (id) ON DELETE CASCADE,
  start_s    REAL NOT NULL,
  end_s      REAL NOT NULL,
  updated_ms INTEGER NOT NULL
);
