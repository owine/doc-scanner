-- Schema version 5: the document pipeline.
--
-- One row per incoming document from any source. `state` is the next thing
-- to do; analyzing / preparing / filing are working states the single worker
-- re-runs after a crash (each is idempotent). `seq` increases on every write
-- so the PWA can poll for changes with ?since=<seq>.
--
-- The BLOB columns hold names, paths and document-derived text, sealed with
-- AES-GCM by DocumentRepo (iv | tag | ciphertext, bound to row id and column;
-- JSON values are sealed as JSON text). NULL stays NULL. Nothing in SQL may
-- look inside them: sha256 stays plaintext for duplicate lookup.

CREATE TABLE IF NOT EXISTS documents (
  id                 TEXT    PRIMARY KEY,
  seq                INTEGER NOT NULL,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  source             TEXT    NOT NULL CHECK (source IN ('picker', 'scanner', 'share', 'email')),
  original_name      BLOB,
  mime               TEXT    NOT NULL,
  size               INTEGER NOT NULL CHECK (size >= 0),
  sha256             TEXT    NOT NULL,
  source_context     BLOB,
  state              TEXT    NOT NULL CHECK (state IN (
                       'received', 'analyzing', 'preparing', 'ready', 'needs_review',
                       'awaiting_login', 'filing', 'filed', 'failed', 'discarded')),
  review_reason      BLOB,
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at    TEXT    NOT NULL,
  error              BLOB,
  analysis           BLOB,
  prepared_mime      TEXT,
  decision           BLOB,
  filing_target      BLOB,
  filed_name         BLOB,
  filed_folder_path  BLOB,
  drive_node_uid     TEXT,
  auto_filed         INTEGER NOT NULL DEFAULT 0 CHECK (auto_filed IN (0, 1)),
  user_edited        INTEGER NOT NULL DEFAULT 0 CHECK (user_edited IN (0, 1)),
  discard_requested  INTEGER NOT NULL DEFAULT 0 CHECK (discard_requested IN (0, 1)),
  discarded_at       TEXT,
  -- A discarded row without discarded_at would never be purged.
  CHECK ((state = 'discarded') = (discarded_at IS NOT NULL))
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
