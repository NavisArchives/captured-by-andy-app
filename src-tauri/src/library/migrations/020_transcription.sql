-- Persist transcription outcomes separately from visual analysis. Old plain
-- transcripts remain intact; a retry can populate timed speech segments.
ALTER TABLE studio_saves ADD COLUMN transcription_state TEXT NOT NULL DEFAULT ''
  CHECK (transcription_state IN ('', 'queued', 'running', 'complete', 'failed'));
ALTER TABLE studio_saves ADD COLUMN transcription_error TEXT NOT NULL DEFAULT '';
ALTER TABLE studio_saves ADD COLUMN transcript_segments TEXT NOT NULL DEFAULT '[]';
ALTER TABLE studio_saves ADD COLUMN transcript_language TEXT NOT NULL DEFAULT 'en-US';
UPDATE studio_saves SET transcription_state = CASE
  WHEN transcript <> '' THEN 'complete'
  WHEN analysed_ms IS NULL THEN 'queued'
  ELSE 'failed' END
WHERE kind = 'video';
