-- What a save is inspiration for: video, photo, colour, portfolio, webapp ('' until picked).
ALTER TABLE studio_saves ADD COLUMN topic TEXT NOT NULL DEFAULT '';
-- Vimeo is a video platform of its own now.
UPDATE studio_saves SET platform = 'vimeo' WHERE platform = 'web' AND url LIKE '%vimeo.com%';
UPDATE studio_saves SET topic = 'video' WHERE kind = 'video' OR platform IN ('tiktok', 'youtube', 'instagram', 'vimeo');
