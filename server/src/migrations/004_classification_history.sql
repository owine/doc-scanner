-- Schema version 4: filing history (FTS5-indexed; similarity recall is not switched on yet).
--
-- `classification_history` records every filing. An FTS5 index over it is kept
-- in sync by triggers, so similarity recall can be switched on later without
-- a backfill migration. Nothing reads this table yet.

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
