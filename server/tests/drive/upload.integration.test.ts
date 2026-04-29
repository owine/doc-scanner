import { describe, it, expect } from 'vitest';
import { ProtonApi } from '../../src/auth/proton-api.js';
import { ProtonAuth } from '../../src/auth/srp.js';
import { DriveClient } from '../../src/drive/client.js';
import { createTestDb } from '../helpers/test-db.js';

const RUN = process.env.INTEGRATION === '1';

describe.skipIf(!RUN)('Drive upload (integration)', () => {
  it('uploads a synthetic file to the test account', async () => {
    const { db, cleanup } = createTestDb();
    let mailboxSecret: { dispose: () => void } | undefined;
    try {
      const api = new ProtonApi('https://mail.proton.me/api', 'external-drive-docscanner@0.1.0');
      const auth = new ProtonAuth(api);
      const result = await auth.login(process.env.PROTON_TEST_EMAIL!, process.env.PROTON_TEST_PASSWORD!);
      mailboxSecret = result.mailboxSecret;

      const client = new DriveClient({
        db,
        encryptionKey: Buffer.alloc(32, 1).toString('base64'),
        appVersion: 'external-drive-docscanner@0.1.0',
        user: result.decryptedKeys,
        session: result.session,
        protonAuth: auth,
      });

      const filename = `docscanner-int-test-${Date.now()}.txt`;
      const bytes = new TextEncoder().encode('doc-scanner integration test');
      const uploaded = await client.uploadFile(filename, bytes, 'text/plain');
      expect(uploaded.nodeUid).toBeTruthy();
      expect(uploaded.driveUrl).toMatch(/drive\.proton\.me/);

      // NOTE: this test leaves the file in the test account's Drive.
      // Manual cleanup needed periodically. The narrow Phase 2 facade doesn't expose
      // a delete operation; if accumulating files becomes painful, expose a
      // `_test_trash(nodeUid)` method or do cleanup via the Drive web UI.
      console.log(`Test uploaded file (clean up later): ${filename} -> ${uploaded.driveUrl}`);
    } finally {
      mailboxSecret?.dispose();
      cleanup();
    }
  }, 120_000);
});
