-- What is said in each library video (Amendment 9b), made on the Mac with
-- whisper.cpp from the clip's sound: kept beside the library, never inside the
-- video file. One row per video; « no_speech » when nothing is said.
CREATE TABLE video_transcripts (
  photo_id  TEXT PRIMARY KEY REFERENCES photos (id) ON DELETE CASCADE,
  state     TEXT NOT NULL CHECK (state IN ('done', 'no_speech', 'failed')),
  language  TEXT NOT NULL DEFAULT '',
  text      TEXT NOT NULL DEFAULT '',
  segments  TEXT NOT NULL DEFAULT '[]',
  model     TEXT NOT NULL DEFAULT '',
  seconds   REAL,
  took_ms   INTEGER,
  error     TEXT NOT NULL DEFAULT '',
  -- Lines Andy corrected by hand; a later automatic run never overwrites them.
  corrected INTEGER NOT NULL DEFAULT 0,
  made_ms   INTEGER NOT NULL
);
