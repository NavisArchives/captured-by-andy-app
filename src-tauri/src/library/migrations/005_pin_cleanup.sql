-- Pins only mean something on a published post of an account.
UPDATE posts SET pinned = 0 WHERE status != 'published' OR account_id IS NULL;
