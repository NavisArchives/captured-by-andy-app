-- What the app measures on each photo's thumbnail, for automatic filters and
-- auto tone. Derived data: safe to drop and recompute.
CREATE TABLE photo_analysis (
  photo_id    TEXT PRIMARY KEY REFERENCES photos (id) ON DELETE CASCADE,
  sharpness   REAL NOT NULL,
  brightness  REAL NOT NULL,
  clip_hi     REAL NOT NULL,
  clip_lo     REAL NOT NULL,
  p01         REAL NOT NULL,
  p50         REAL NOT NULL,
  p99         REAL NOT NULL,
  mean_r      REAL NOT NULL,
  mean_g      REAL NOT NULL,
  mean_b      REAL NOT NULL,
  burst_id    TEXT,
  burst_size  INTEGER NOT NULL DEFAULT 1,
  burst_best  INTEGER NOT NULL DEFAULT 1,
  analysed_ms INTEGER NOT NULL
);
CREATE INDEX photo_analysis_burst ON photo_analysis (burst_id);

-- Looks pinned to the number keys in the editor.
CREATE TABLE look_favorites (
  look_id  TEXT PRIMARY KEY REFERENCES looks (id) ON DELETE CASCADE,
  position INTEGER NOT NULL
);
