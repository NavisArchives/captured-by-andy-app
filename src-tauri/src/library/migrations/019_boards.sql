-- Boards: inspiration saves gathered into one (a clinic's three videos and its
-- website), linked to a client, a pillar and/or a series or campaign.
CREATE TABLE studio_boards (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  client     TEXT NOT NULL DEFAULT '',
  pillar_id  TEXT REFERENCES studio_pillars (id) ON DELETE SET NULL,
  family_id  TEXT REFERENCES studio_families (id) ON DELETE SET NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);

-- A save is in at most one board; removing the board leaves its saves in place.
ALTER TABLE studio_saves ADD COLUMN board_id TEXT REFERENCES studio_boards (id) ON DELETE SET NULL;
CREATE INDEX studio_saves_board ON studio_saves (board_id);
