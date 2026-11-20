-- Studio: planning videos and posts, from a saved inspiration to a posted
-- piece. Pillars hold families (a series or a client campaign), families hold
-- pieces. Folders on disk are made by the app; their names never change once
-- footage is inside, so CapCut keeps finding its clips.

CREATE TABLE studio_pillars (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  folder     TEXT NOT NULL DEFAULT '',      -- e.g. 01_HAIR, fixed once made
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);

CREATE TABLE studio_families (
  id         TEXT PRIMARY KEY,
  pillar_id  TEXT NOT NULL REFERENCES studio_pillars (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'series' CHECK (kind IN ('series', 'campaign', 'singles')),
  name       TEXT NOT NULL,
  code       TEXT NOT NULL DEFAULT '',      -- S01, or the client's short code
  client     TEXT NOT NULL DEFAULT '',
  folder     TEXT NOT NULL DEFAULT '',
  archived   INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE INDEX studio_families_pillar ON studio_families (pillar_id);

CREATE TABLE studio_shoot_days (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,                 -- YYYY-MM-DD
  title      TEXT NOT NULL DEFAULT '',
  location   TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);

CREATE TABLE studio_brand_jobs (
  id                TEXT PRIMARY KEY,
  client            TEXT NOT NULL,
  campaign          TEXT NOT NULL DEFAULT '',
  family_id         TEXT REFERENCES studio_families (id) ON DELETE SET NULL,
  brief             TEXT NOT NULL DEFAULT '',
  deliverables      TEXT NOT NULL DEFAULT '',
  review_date       TEXT,
  live_date         TEXT,
  revisions_allowed INTEGER,
  revisions_used    INTEGER NOT NULL DEFAULT 0,
  rights            TEXT NOT NULL DEFAULT '',  -- channels, paid ads, territory, in words
  rights_end        TEXT,
  exclusivity_end   TEXT,
  paid_ads_end      TEXT,
  fee               TEXT NOT NULL DEFAULT '',
  invoice_no        TEXT NOT NULL DEFAULT '',
  invoice_status    TEXT NOT NULL DEFAULT 'none' CHECK (invoice_status IN ('none', 'sent', 'paid')),
  paid_date         TEXT,
  notes             TEXT NOT NULL DEFAULT '',
  created_ms        INTEGER NOT NULL,
  updated_ms        INTEGER NOT NULL
);

CREATE TABLE studio_ideas (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  hook       TEXT NOT NULL DEFAULT '',
  format     TEXT NOT NULL DEFAULT '',
  pillar_id  TEXT REFERENCES studio_pillars (id) ON DELETE SET NULL,
  family_id  TEXT REFERENCES studio_families (id) ON DELETE SET NULL,
  platforms  TEXT NOT NULL DEFAULT '',      -- comma list: tiktok,instagram
  status     TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox', 'keep', 'maybe', 'parked', 'dropped', 'greenlit')),
  score_hook INTEGER,
  score_send INTEGER,
  score_fit  INTEGER,
  score_ease INTEGER,
  notes      TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'typed', -- typed | voice | save
  deadline   TEXT,                          -- trend expiry or client date, YYYY-MM-DD
  piece_id   TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  touched_ms INTEGER NOT NULL
);
CREATE INDEX studio_ideas_status ON studio_ideas (status, touched_ms);

CREATE TABLE studio_pieces (
  id            TEXT PRIMARY KEY,
  idea_id       TEXT REFERENCES studio_ideas (id) ON DELETE SET NULL,
  pillar_id     TEXT REFERENCES studio_pillars (id) ON DELETE SET NULL,
  family_id     TEXT REFERENCES studio_families (id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  episode       INTEGER,
  code          TEXT NOT NULL DEFAULT '',   -- S01-07, ZEB-02, single
  format        TEXT NOT NULL DEFAULT '',
  platforms     TEXT NOT NULL DEFAULT '',
  stage         TEXT NOT NULL DEFAULT 'planned' CHECK (stage IN ('planned', 'shot', 'editing', 'ready', 'posted', 'reviewed')),
  parked        INTEGER NOT NULL DEFAULT 0,
  waiting_brand INTEGER NOT NULL DEFAULT 0,
  folder        TEXT,                       -- absolute path, found again if moved
  brief         TEXT NOT NULL DEFAULT '{}', -- the brief and script (JSON, shaped by the page)
  shoot_day_id  TEXT REFERENCES studio_shoot_days (id) ON DELETE SET NULL,
  planned_date  TEXT,                       -- posting date, YYYY-MM-DD
  is_paid       INTEGER NOT NULL DEFAULT 0,
  brand_job_id  TEXT REFERENCES studio_brand_jobs (id) ON DELETE SET NULL,
  disclosure    TEXT NOT NULL DEFAULT '{}', -- {label, tag, toggle} ticks for paid work
  posts         TEXT NOT NULL DEFAULT '[]', -- [{platform, url, at, file}]
  notes         TEXT NOT NULL DEFAULT '',
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE INDEX studio_pieces_family ON studio_pieces (family_id);
CREATE INDEX studio_pieces_stage ON studio_pieces (stage);

-- Clips and photos from the library that belong to a piece.
CREATE TABLE studio_piece_media (
  piece_id TEXT NOT NULL REFERENCES studio_pieces (id) ON DELETE CASCADE,
  photo_id TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'footage',
  position REAL NOT NULL DEFAULT 0,
  added_ms INTEGER NOT NULL,
  PRIMARY KEY (piece_id, photo_id)
);

-- Saved inspiration: a link, a screenshot, a screen recording or a note.
CREATE TABLE studio_saves (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('link', 'image', 'video', 'note')),
  platform        TEXT NOT NULL DEFAULT 'web',
  url             TEXT NOT NULL DEFAULT '',
  url_key         TEXT NOT NULL DEFAULT '',  -- cleaned link, to spot doubles
  title           TEXT NOT NULL DEFAULT '',
  author          TEXT NOT NULL DEFAULT '',
  file_path       TEXT,                      -- the screenshot or recording, left where it is
  thumb           TEXT,                      -- file name in the Studio thumbnail cache
  why             TEXT NOT NULL DEFAULT '',
  chips           TEXT NOT NULL DEFAULT '',  -- hook,format,edit,audio,light,caption
  tags            TEXT NOT NULL DEFAULT '',
  auto_labels     TEXT NOT NULL DEFAULT '',
  ocr_text        TEXT NOT NULL DEFAULT '',
  transcript      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox', 'library', 'archived')),
  pillar_id       TEXT REFERENCES studio_pillars (id) ON DELETE SET NULL,
  captured_via    TEXT NOT NULL DEFAULT 'paste',
  analysed_ms     INTEGER,
  link_ok         INTEGER,
  checked_ms      INTEGER,
  resurfaced_ms   INTEGER,
  resurface_count INTEGER NOT NULL DEFAULT 0,
  created_ms      INTEGER NOT NULL,
  updated_ms      INTEGER NOT NULL
);
CREATE INDEX studio_saves_key ON studio_saves (url_key);
CREATE INDEX studio_saves_status ON studio_saves (status, created_ms);

CREATE TABLE studio_save_ideas (
  save_id TEXT NOT NULL REFERENCES studio_saves (id) ON DELETE CASCADE,
  idea_id TEXT NOT NULL REFERENCES studio_ideas (id) ON DELETE CASCADE,
  PRIMARY KEY (save_id, idea_id)
);

-- The 7-day review of a posted piece.
CREATE TABLE studio_reviews (
  id         TEXT PRIMARY KEY,
  piece_id   TEXT NOT NULL UNIQUE REFERENCES studio_pieces (id) ON DELETE CASCADE,
  platform   TEXT NOT NULL DEFAULT '',
  views      INTEGER,
  watch_time REAL,
  skip_rate  REAL,
  sends      INTEGER,
  saves      INTEGER,
  follows    INTEGER,
  learning   TEXT NOT NULL DEFAULT '',
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);

-- Accounts to keep an eye on (Instagram business discovery, by hand otherwise).
CREATE TABLE studio_watch (
  id         TEXT PRIMARY KEY,
  platform   TEXT NOT NULL DEFAULT 'instagram',
  handle     TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  last       TEXT NOT NULL DEFAULT '',     -- the last fetched numbers and posts (JSON)
  checked_ms INTEGER,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
