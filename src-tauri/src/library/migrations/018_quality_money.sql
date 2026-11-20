-- Apple's overall score (-1..1) and "utility" (a document, receipt or screen)
-- for each photo, measured on its thumbnail: NULL until measured.
ALTER TABLE photo_analysis ADD COLUMN aesthetics REAL;
ALTER TABLE photo_analysis ADD COLUMN utility INTEGER;

-- Money: when an invoice went out, and the fee as a number.
ALTER TABLE studio_brand_jobs ADD COLUMN invoice_sent_date TEXT;
ALTER TABLE studio_brand_jobs ADD COLUMN amount REAL;
ALTER TABLE studio_brand_jobs ADD COLUMN currency TEXT;
