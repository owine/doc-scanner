-- Schema version 5: the document pipeline.
--
-- One row per incoming document from any source. `state` is the next thing
-- to do; analyzing / preparing / filing are working states the single worker
-- re-runs after a crash (each is idempotent). `seq` increases on every write
-- so the PWA can poll for changes with ?since=<seq>.

CREATE TABLE IF NOT EXISTS documents (
  id                 TEXT    PRIMARY KEY,
  seq                INTEGER NOT NULL,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  source             TEXT    NOT NULL CHECK (source IN ('picker', 'scanner', 'share', 'email')),
  original_name      TEXT,
  mime               TEXT    NOT NULL,
  size               INTEGER NOT NULL,
  sha256             TEXT    NOT NULL,
  source_context     TEXT,
  state              TEXT    NOT NULL CHECK (state IN (
                       'received', 'analyzing', 'preparing', 'ready', 'needs_review',
                       'awaiting_login', 'filing', 'filed', 'failed', 'discarded')),
  review_reason      TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TEXT    NOT NULL,
  error              TEXT,
  analysis           TEXT CHECK (analysis IS NULL OR json_valid(analysis)),
  prepared_mime      TEXT,
  decision           TEXT CHECK (decision IS NULL OR json_valid(decision)),
  filing_target      TEXT CHECK (filing_target IS NULL OR json_valid(filing_target)),
  filed_name         TEXT,
  filed_folder_path  TEXT,
  drive_node_uid     TEXT,
  auto_filed         INTEGER NOT NULL DEFAULT 0,
  user_edited        INTEGER NOT NULL DEFAULT 0,
  discard_requested  INTEGER NOT NULL DEFAULT 0,
  discarded_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_sha256 ON documents(sha256);
CREATE INDEX IF NOT EXISTS idx_documents_work ON documents(state, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_seq ON documents(seq);

-- Monotonic source for documents.seq. MAX(seq)+1 would hand a purged row's
-- number to the next write, and a client polling with that cursor would
-- miss the change.
CREATE TABLE IF NOT EXISTS document_seq (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  value  INTEGER NOT NULL
);
INSERT OR IGNORE INTO document_seq (id, value) VALUES (1, 0);

-- Saved settings reuse migration 003's app_settings table, under keys
-- prefixed "filing." (see settings-store.ts).

-- The last walked Drive folder tree (paths + recent filenames), encrypted,
-- so documents can be analysed while no one is logged in.
CREATE TABLE IF NOT EXISTS folder_cache (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  encrypted_tree  BLOB    NOT NULL,
  walked_at       TEXT    NOT NULL
);
