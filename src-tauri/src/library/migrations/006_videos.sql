-- Videos live in the library next to photos: flagged, with their length.
ALTER TABLE photos ADD COLUMN is_video INTEGER NOT NULL DEFAULT 0;
ALTER TABLE photos ADD COLUMN duration_s REAL;
