import { describe, it, expect } from 'vitest';
import * as openpgp from 'openpgp';
import { DriveClient } from '../../src/drive/client.js';
import { ProtonAuth } from '../../src/auth/srp.js';
import { ProtonApi } from '../../src/auth/proton-api.js';
import { createTestDb } from '../helpers/test-db.js';
import type { DB } from '../../src/db.js';

async function makeClient(db: DB): Promise<DriveClient> {
  const { privateKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'ed25519Legacy',
    userIDs: [{ email: 'x@y.test' }],
    passphrase: 'p',
    format: 'object',
  });
  const decrypted = await openpgp.decryptKey({ privateKey, passphrase: 'p' });

  const protonAuth = new ProtonAuth(
    new ProtonApi('https://api.example.test', 'external-drive-docscanner@0.1.0'),
  );

  return new DriveClient({
    db,
    encryptionKey: Buffer.alloc(32, 1).toString('base64'),
    appVersion: 'external-drive-docscanner@0.1.0',
    user: {
      primaryAddress: { email: 'x@y.test', addressId: 'a1' },
      primaryKey: decrypted,
      addresses: [
        { email: 'x@y.test', addressId: 'a1', keys: [{ id: 'k1', key: decrypted }], primaryKeyIndex: 0 },
      ],
    },
    session: { uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'x@y.test' },
    protonAuth,
  });
}

describe('DriveClient', () => {
  it('constructs without throwing given valid deps', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const client = await makeClient(db);
      expect(client).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('clearCaches empties both the entities cache and the event cursors', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const client = await makeClient(db);
      // Seed both persisted caches, then prove clearCaches wipes both — the
      // logout contract that keeps one account's cached state from leaking to
      // the next login.
      db.prepare("INSERT INTO entities_cache (key, encrypted_blob) VALUES ('node-1', x'00')").run();
      db.prepare("INSERT INTO event_cursors (scope_id, cursor) VALUES ('core', 'c1')").run();

      await client.clearCaches();

      const entities = db.prepare('SELECT COUNT(*) AS c FROM entities_cache').get() as { c: number };
      const cursors = db.prepare('SELECT COUNT(*) AS c FROM event_cursors').get() as { c: number };
      expect(entities.c).toBe(0);
      expect(cursors.c).toBe(0);
    } finally {
      cleanup();
    }
  });
});
