-- Schema version 3: event cursors are keyed by tree-event scope.
--
-- The SDK asks for a cursor per scope: the literal 'core' scope plus one per
-- volume (internal/events/index.ts). The previous single-row table conflated
-- them. Nothing ever wrote to it (the SDK's LatestEventIdProvider is
-- read-only), so there is no data to migrate.

DROP TABLE IF EXISTS event_cursors;

CREATE TABLE event_cursors (
  scope_id TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Small key/value table for install-scoped settings. First user: the Drive
-- SDK's `clientUid`, which must stay stable across restarts so the SDK can
-- recognise (and clean up) upload drafts left behind by our own interrupted
-- uploads instead of refusing them as another client's.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
