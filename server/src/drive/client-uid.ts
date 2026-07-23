import { randomUUID } from 'node:crypto';
import type { DB } from '../db.js';

const CLIENT_UID_KEY = 'drive_client_uid';

/**
 * Returns this installation's stable Drive `clientUid`, generating it on first
 * call.
 *
 * The SDK uses it to tell its own abandoned upload drafts apart from another
 * client's: with a matching UID it cleans the draft up and retries, without one
 * it throws and demands an explicit override (see `ProtonDriveConfig.clientUid`).
 * A value that changed per process would make every retry after a crash look
 * like a foreign draft.
 */
export function getOrCreateClientUid(db: DB): string {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(CLIENT_UID_KEY) as { value: string } | undefined;
  if (row) return row.value;

  const uid = randomUUID();
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(CLIENT_UID_KEY, uid);
  return uid;
}
