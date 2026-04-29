import { describe, it, expect } from 'vitest';
import { DriveClient } from '../../src/drive/client.js';
import { createTestDb } from '../helpers/test-db.js';
import { getSharedSession } from '../helpers/integration-session.js';

const RUN = process.env.INTEGRATION === '1';

describe.skipIf(!RUN)('Drive upload (integration)', () => {
  it('uploads a synthetic file to the test account', async () => {
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

      const filename = `docscanner-int-test-${Date.now()}.txt`;
      const bytes = new TextEncoder().encode('doc-scanner integration test');
      const uploaded = await client.uploadFile(filename, bytes, 'text/plain');
      expect(uploaded.nodeUid).toBeTruthy();
      expect(uploaded.driveUrl).toMatch(/drive\.proton\.me/);

      // Test leaves the file in the account's Drive.
      // Manual cleanup periodically via web UI.
      console.log(`Uploaded test file (clean up later): ${filename} -> ${uploaded.driveUrl}`);
    } finally {
      cleanup();
    }
  }, 120_000);
});
