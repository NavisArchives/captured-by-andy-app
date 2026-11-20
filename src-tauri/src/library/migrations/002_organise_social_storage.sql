-- Slices 2-3: organisation (albums, tags), social (accounts, posts), the local
-- library of selected photos, archive locations, and the Finder tags this app
-- added. Photos, albums and posts only ever reference each other: adding a
-- photo to an album or a post never copies or moves a file.

CREATE TABLE albums (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  cover_photo_id TEXT REFERENCES photos (id) ON DELETE SET NULL,
  created_ms     INTEGER NOT NULL,
  updated_ms     INTEGER NOT NULL
);

CREATE TABLE photo_albums (
  album_id TEXT NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
  photo_id TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_ms INTEGER NOT NULL,
  PRIMARY KEY (album_id, photo_id)
);
CREATE INDEX photo_albums_photo ON photo_albums (photo_id);

CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_ms INTEGER NOT NULL
);

CREATE TABLE photo_tags (
  photo_id TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  added_ms INTEGER NOT NULL,
  PRIMARY KEY (photo_id, tag_id)
);
CREATE INDEX photo_tags_tag ON photo_tags (tag_id);

CREATE TABLE accounts (
  id                   TEXT PRIMARY KEY,
  platform             TEXT NOT NULL DEFAULT 'instagram' CHECK (platform IN ('instagram')),
  display_name         TEXT NOT NULL DEFAULT '',
  username             TEXT NOT NULL,
  avatar_photo_id      TEXT REFERENCES photos (id) ON DELETE SET NULL,
  follower_count       INTEGER,
  following_count      INTEGER,
  published_post_count INTEGER,
  notes                TEXT NOT NULL DEFAULT '',
  created_ms           INTEGER NOT NULL,
  updated_ms           INTEGER NOT NULL,
  UNIQUE (platform, username)
);

-- A post's kind (single / carousel) follows from how many photos it has.
-- Publication history is derived from published posts, never stored twice.
CREATE TABLE posts (
  id           TEXT PRIMARY KEY,
  account_id   TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  caption      TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'idea'
               CHECK (status IN ('idea', 'building', 'ready', 'scheduled', 'published', 'archived')),
  scheduled_at TEXT,
  published_at TEXT,
  plan_order   REAL,  -- planned publishing order, used only by the future-grid preview
  created_ms   INTEGER NOT NULL,
  updated_ms   INTEGER NOT NULL
);
CREATE INDEX posts_account_status ON posts (account_id, status);

CREATE TABLE post_photos (
  post_id  TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  photo_id TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (post_id, photo_id)
);
CREATE INDEX post_photos_photo ON post_photos (photo_id);

-- Working copies of selected photos in the local library. The original stays
-- the canonical master; these are copies the app made and may remove again.
CREATE TABLE local_copies (
  asset_id    TEXT PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,
  photo_id    TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  path        TEXT NOT NULL UNIQUE,
  size        INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX local_copies_photo ON local_copies (photo_id);

-- Where originals can be archived. Only 'local' (a folder, e.g. an external
-- drive) is implemented; 's3' is reserved so a cloud provider needs no migration.
CREATE TABLE storage_locations (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('local', 's3')),
  label      TEXT NOT NULL,
  config     TEXT NOT NULL,  -- JSON, never secrets
  created_ms INTEGER NOT NULL
);

CREATE TABLE archived_assets (
  asset_id    TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES storage_locations (id) ON DELETE CASCADE,
  remote_key  TEXT NOT NULL,
  size        INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  archived_ms INTEGER NOT NULL,
  PRIMARY KEY (asset_id, location_id)
);

-- Files the app gave the Finder "selected" tag. Only these are ever untagged,
-- so a tag the user set by hand is never removed.
CREATE TABLE finder_tags (
  asset_id  TEXT PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,
  tagged_ms INTEGER NOT NULL
);

-- Looks: Lightroom presets and LUTs, imported as copies (the files the user
-- made are only read). Every look is baked to a 3D LUT so presets, .cube LUTs
-- and HaldCLUTs all render through one path.
CREATE TABLE looks (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('preset', 'cube', 'hald')),
  name        TEXT NOT NULL,
  author      TEXT NOT NULL DEFAULT '',
  collection  TEXT NOT NULL,
  source_path TEXT NOT NULL UNIQUE,
  copy_path   TEXT,                        -- the app's copy of a small source file
  settings    TEXT NOT NULL DEFAULT '{}',  -- preset values the LUT could not hold (grain, vignette)
  created_ms  INTEGER NOT NULL
);

-- The look and basic adjustments chosen for a photo. Nothing is rendered into
-- the original: previews and exports apply this on the fly.
CREATE TABLE photo_looks (
  photo_id    TEXT PRIMARY KEY REFERENCES photos (id) ON DELETE CASCADE,
  look_id     TEXT REFERENCES looks (id) ON DELETE SET NULL,
  strength    REAL NOT NULL DEFAULT 1.0,
  adjustments TEXT NOT NULL DEFAULT '{}',
  updated_ms  INTEGER NOT NULL
);
