-- Schema version 3: Phase 5 classification history (FTS5 few-shot retrieval).
--
-- `classification_history` records every confirmed Drive save so that future
-- /api/classify calls can include a `<examples>` block of prior filings as
-- in-context shots, helping Haiku align with the user's naming + folder
-- conventions over time.
--
-- The FTS5 virtual table is provisioned now even though slice 3 only uses
-- `findRecent(N)` (most-recent N saves regardless of similarity) — keeping
-- the inverted index in sync from day one means a future similarity-based
-- retrieval can flip the switch without a backfill migration.

CREATE TABLE IF NOT EXISTS classification_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  saved_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  ocr_snippet     TEXT    NOT NULL,
  final_name      TEXT    NOT NULL,
  folder_link_id  TEXT    NOT NULL,
  folder_path     TEXT    NOT NULL,
  drive_node_uid  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_classification_history_saved_at
  ON classification_history(saved_at DESC);

-- External-content FTS5 keeps the actual data in classification_history;
-- this virtual table only stores the inverted index. Saves disk + lets us
-- query non-FTS columns directly without join detours.
CREATE VIRTUAL TABLE IF NOT EXISTS classification_history_fts USING fts5(
  ocr_snippet, final_name, folder_path,
  content='classification_history',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS classification_history_ai
AFTER INSERT ON classification_history BEGIN
  INSERT INTO classification_history_fts(rowid, ocr_snippet, final_name, folder_path)
  VALUES (new.id, new.ocr_snippet, new.final_name, new.folder_path);
END;

CREATE TRIGGER IF NOT EXISTS classification_history_ad
AFTER DELETE ON classification_history BEGIN
  INSERT INTO classification_history_fts(classification_history_fts, rowid, ocr_snippet, final_name, folder_path)
  VALUES ('delete', old.id, old.ocr_snippet, old.final_name, old.folder_path);
END;

-- No update trigger: history rows are immutable.
