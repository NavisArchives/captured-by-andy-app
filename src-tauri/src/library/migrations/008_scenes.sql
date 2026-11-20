-- A 64-bit difference hash of each thumbnail: near-identical frames (the same
-- view shot a few times) have hashes a few bits apart, which groups them into
-- scenes together with bursts.
ALTER TABLE photo_analysis ADD COLUMN dhash INTEGER;
