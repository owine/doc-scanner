-- Schema version 2: drive integration caches.

CREATE TABLE IF NOT EXISTS entities_cache (
  key TEXT PRIMARY KEY,
  encrypted_blob BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_cursors (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
