import type { LatestEventIdProvider } from '@protontech/drive-sdk';
import type { DB } from '../db.js';

/**
 * SDK `LatestEventIdProvider` implementation backed by a single-row
 * SQLite table.
 *
 * The cursor is an opaque, non-secret event ID issued by the Proton API,
 * so it is stored in plaintext — no encryption envelope is needed.
 *
 * Phase 2 only tracks a single tree event scope at a time, so the
 * `treeEventScopeId` argument from the SDK is intentionally ignored and
 * the row is keyed on the constant `id = 1`. A multi-scope variant can
 * extend the table later without changing the SDK contract.
 */
export class EventIdStore implements LatestEventIdProvider {
  constructor(private readonly db: DB) {}

  async getLatestEventId(_treeEventScopeId: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT cursor FROM event_cursors WHERE id = 1')
      .get() as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  async setLatestEventId(cursor: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO event_cursors (id, cursor, updated_at)
         VALUES (1, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           cursor = excluded.cursor,
           updated_at = datetime('now')`,
      )
      .run(cursor);
  }
}
