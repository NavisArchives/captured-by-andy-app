-- The good parts of a video, marked while culling (in and out points), so a
-- reel can start from them. The video file itself is never touched.
CREATE TABLE video_moments (
  id         TEXT PRIMARY KEY,
  photo_id   TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  start_s    REAL NOT NULL CHECK (start_s >= 0),
  end_s      REAL NOT NULL CHECK (end_s > start_s),
  created_ms INTEGER NOT NULL
);
CREATE INDEX video_moments_photo ON video_moments (photo_id, start_s);
