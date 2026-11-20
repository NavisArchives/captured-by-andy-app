-- The picture profile a video was filmed in (Sony's CaptureGammaEquation:
-- rec709, s-cinetone, s-log3, s-log3-cine...). S-Log3 clips are converted to
-- normal colour wherever they're shown or exported. 'unknown' once looked for.
ALTER TABLE photos ADD COLUMN gamma TEXT;
