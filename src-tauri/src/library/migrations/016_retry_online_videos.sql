-- Online-only videos whose frame couldn't be read (often just a download that
-- didn't come in time) get another try instead of staying without a picture.
UPDATE photos SET thumb_state = 'unavailable'
WHERE is_video = 1 AND thumb_state = 'failed'
  AND id IN (SELECT photo_id FROM assets WHERE storage_state = 'cloud_only');
