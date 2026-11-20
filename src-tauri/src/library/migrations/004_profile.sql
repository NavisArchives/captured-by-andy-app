-- What the Instagram profile preview shows beyond counts.
ALTER TABLE accounts ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN link TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN category TEXT NOT NULL DEFAULT '';
-- Instagram lets you pin up to three posts to the top of the grid.
ALTER TABLE posts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
