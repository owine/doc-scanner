-- Schema version 8: combining documents and filing one with another
-- (docs/superpowers/specs/2026-10-13-combine-and-file-with-design.md).
-- combined_into: on a part a combine discarded, the combined document's id.
--   Plaintext: an id only. Cleared on restore.
-- anchor: sealed JSON {documentId, name, folder}, the document a "File with"
--   re-analysis pairs this one with, as it was when asked. Sealed: it holds a
--   name and a path.
-- reanalyzed: the user asked for this document to be analysed again, so its
--   analysis always goes to review.
ALTER TABLE documents ADD COLUMN combined_into TEXT;
ALTER TABLE documents ADD COLUMN anchor BLOB;
ALTER TABLE documents ADD COLUMN reanalyzed INTEGER NOT NULL DEFAULT 0 CHECK (reanalyzed IN (0, 1));
