-- How a post goes to Instagram: its export ratio (one per carousel) and where
-- the 3:4 grid tile sits on its cover, from -1 (left or top) to 1 (right or
-- bottom), like Instagram's "Adjust preview".
ALTER TABLE posts ADD COLUMN export_ratio TEXT NOT NULL DEFAULT '3:4' CHECK (export_ratio IN ('3:4', '4:5', '1:1'));
ALTER TABLE posts ADD COLUMN tile_offset REAL NOT NULL DEFAULT 0;
-- Posts planned before 3:4 exports existed keep the 4:5 they were made for.
UPDATE posts SET export_ratio = '4:5';
