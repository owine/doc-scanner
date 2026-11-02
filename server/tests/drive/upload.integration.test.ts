import { describe, it, expect } from 'vitest';
import { DriveClient } from '../../src/drive/client.js';
import { createTestDb } from '../helpers/test-db.js';
import { getSharedSession, keepRefreshedSession } from '../helpers/integration-session.js';

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
        onSessionRefreshed: keepRefreshedSession(shared),
      });

      const filename = `docscanner-int-test-${Date.now()}.txt`;
      const bytes = new TextEncoder().encode('doc-scanner integration test');
      const uploaded = await client.uploadFile(filename, bytes, 'text/plain');
      try {
        expect(uploaded.nodeUid).toBeTruthy();
        expect(uploaded.driveUrl).toMatch(/drive\.proton\.me/);
      } finally {
        // Removed for good (trash, then delete), even when an assertion
        // failed, so a run leaves nothing in the account's Drive. The SDK
        // already retries transient errors; if it still fails, say which
        // file to remove by hand (it may be in the trash).
        await client.deleteFile(uploaded.nodeUid).catch((err: unknown) => {
          console.error(`Could not delete the test file; remove it by hand: ${filename} -> ${uploaded.driveUrl}`);
          throw err;
        });
      }
    } finally {
      cleanup();
    }
  }, 120_000);
});
