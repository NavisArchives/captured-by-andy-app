-- What's in each photo, from Apple's on-device image recognition of its tile
-- or preview (never the original): "beach", "sunset_sunrise", "people"...
CREATE TABLE photo_labels (
  photo_id   TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  confidence REAL NOT NULL,
  PRIMARY KEY (photo_id, label)
);
CREATE INDEX photo_labels_label ON photo_labels (label, confidence);
ALTER TABLE photos ADD COLUMN labelled_ms INTEGER;
