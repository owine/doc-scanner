import type { LatestEventIdProvider } from '@protontech/drive-sdk';
import type { DB } from '../db.js';

/**
 * SDK `LatestEventIdProvider` implementation backed by SQLite.
 *
 * The cursor is an opaque, non-secret event ID issued by the Proton API, so it
 * is stored in plaintext — no encryption envelope is needed.
 *
 * Note on the contract: `LatestEventIdProvider` declares only
 * `getLatestEventId(treeEventScopeId)`. The SDK never writes the cursor back,
 * so persisting it is the *application's* job — it has to happen from the
 * `DriveListener` passed to `subscribeToTreeEvents`, using the `eventId` and
 * `treeEventScopeId` carried on each event. `setLatestEventId` exists for that
 * caller; until event subscription is wired up, `getLatestEventId` correctly
 * returns null and the SDK starts from the current server state.
 *
 * Scopes are namespaced by the SDK: the literal 'core' scope plus one per
 * volume ID. They must not share a row.
 */
export class EventIdStore implements LatestEventIdProvider {
  constructor(private readonly db: DB) {}

  async getLatestEventId(treeEventScopeId: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT cursor FROM event_cursors WHERE scope_id = ?')
      .get(treeEventScopeId) as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  async setLatestEventId(treeEventScopeId: string, cursor: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO event_cursors (scope_id, cursor, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(scope_id) DO UPDATE SET
           cursor = excluded.cursor,
           updated_at = datetime('now')`,
      )
      .run(treeEventScopeId, cursor);
  }

  /** Drops all cursors. Called on logout alongside the entities cache. */
  async clear(): Promise<void> {
    this.db.prepare('DELETE FROM event_cursors').run();
  }
}
