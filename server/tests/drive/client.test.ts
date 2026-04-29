import { describe, it, expect } from 'vitest';
import * as openpgp from 'openpgp';
import { DriveClient } from '../../src/drive/client.js';
import { ProtonAuth } from '../../src/auth/srp.js';
import { ProtonApi } from '../../src/auth/proton-api.js';
import { createTestDb } from '../helpers/test-db.js';

describe('DriveClient', () => {
  it('constructs without throwing given valid deps', async () => {
    const { db, cleanup } = createTestDb();
    try {
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

      const client = new DriveClient({
        db,
        encryptionKey: Buffer.alloc(32, 1).toString('base64'),
        appVersion: 'external-drive-docscanner@0.1.0',
        user: {
          primaryAddress: { email: 'x@y.test', addressId: 'a1' },
          primaryKey: decrypted,
          addresses: [{ email: 'x@y.test', addressId: 'a1', key: decrypted }],
        },
        session: { uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'x@y.test' },
        protonAuth,
      });

      expect(client).toBeDefined();
    } finally {
      cleanup();
    }
  });
});
