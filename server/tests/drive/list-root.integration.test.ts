import { describe, it, expect } from 'vitest';
import { DriveClient } from '../../src/drive/client.js';
import { createTestDb } from '../helpers/test-db.js';
import { getSharedSession } from '../helpers/integration-session.js';

const RUN = process.env.INTEGRATION === '1';

describe.skipIf(!RUN)('Drive list-root (integration)', () => {
  it('lists the root folder of the test account', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const shared = await getSharedSession();
      const client = new DriveClient({
        db,
        encryptionKey: Buffer.alloc(32, 1).toString('base64'),
        appVersion: 'external-drive-docscanner@0.1.0',
        user: shared.decryptedKeys,
        session: shared.session,
        protonAuth: shared.auth,
      });

      const root = await client.listRoot();
      expect(root.root.uid).toBeTruthy();
      expect(root.root.name).toBeTruthy();
    } finally {
      cleanup();
    }
  }, 60_000);
});
