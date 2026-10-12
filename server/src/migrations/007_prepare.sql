-- Schema version 7: what preparing a document recorded (spec §4, slice 3).
-- prepare_note: a fixed sentence shown with a document filed without the
-- text layer it should have had (OCR missing, failed or slow). Plaintext:
-- it never holds a name or document text.
-- has_thumbnail: an encrypted first-page thumbnail waits in the inbox.
ALTER TABLE documents ADD COLUMN prepare_note TEXT;
ALTER TABLE documents ADD COLUMN has_thumbnail INTEGER NOT NULL DEFAULT 0 CHECK (has_thumbnail IN (0, 1));
