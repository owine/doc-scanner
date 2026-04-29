import { describe, it, expect } from 'vitest';
import { ProtonApi } from '../../src/auth/proton-api.js';
import { ProtonAuth } from '../../src/auth/srp.js';
import { DriveClient } from '../../src/drive/client.js';
import { createTestDb } from '../helpers/test-db.js';

const RUN = process.env.INTEGRATION === '1';

describe.skipIf(!RUN)('Drive list-root (integration)', () => {
  it('lists the root folder of the test account', async () => {
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

      const root = await client.listRoot();
      expect(root.root.uid).toBeTruthy();
      expect(root.root.name).toBeTruthy();
      // Children may be empty for a fresh test account — don't assert > 0
    } finally {
      mailboxSecret?.dispose();
      cleanup();
    }
  }, 60_000);
});
