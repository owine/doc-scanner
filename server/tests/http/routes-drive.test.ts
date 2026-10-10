import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as openpgp from 'openpgp';
import { createApp } from '../../src/http/server.js';
import { createTestDb } from '../helpers/test-db.js';
import type { ProtonAuth } from '../../src/auth/srp.js';
import { _resetSids } from '../../src/http/middleware.js';
import { _resetLiveSessions } from '../../src/auth/live-session.js';
import { MailboxSecret } from '../../src/auth/secrets/mailbox-password.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import { DriveClient } from '../../src/drive/client.js';
import { logger } from '../../src/logger.js';

const KEY = Buffer.alloc(32, 1).toString('base64');
let keys: DecryptedUserKey;
let cleanup: () => void = () => {};

beforeAll(async () => {
  const { privateKey } = await openpgp.generateKey({ type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'e@x.test' }], passphrase: 'p', format: 'object' });
  const decrypted = await openpgp.decryptKey({ privateKey, passphrase: 'p' });
  keys = {
    primaryAddress: { email: 'e@x.test', addressId: 'a1' },
    primaryKey: decrypted,
    addresses: [{ email: 'e@x.test', addressId: 'a1', keys: [{ id: 'k1', key: decrypted }], primaryKeyIndex: 0 }],
  };
});
beforeEach(() => {
  _resetSids();
  _resetLiveSessions();
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

async function loggedIn() {
  const t = createTestDb();
  cleanup = t.cleanup;
  const fakeAuth = {
    login: vi.fn().mockResolvedValue({
      session: { uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'e@x.test' },
      mailboxSecret: new MailboxSecret(new Uint8Array([0])),
      decryptedKeys: keys,
    }),
    refresh: vi.fn(),
  } as unknown as ProtonAuth;
  const app = createApp({ db: t.db, encryptionKey: KEY, protonAuth: fakeAuth });
  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'e@x.test', password: 'p' }),
  });
  return { app, cookie: login.headers.get('set-cookie')!.split(';')[0]! };
}

describe('drive test upload', () => {
  it('answers a failed upload with a fixed error and logs only its type', async () => {
    const { app, cookie } = await loggedIn();
    vi.spyOn(DriveClient.prototype, 'uploadFile').mockRejectedValue(new TypeError('/Private/Northwind Energy'));
    const warn = vi.spyOn(logger, 'warn');
    const res = await app.request('/api/drive/test-upload', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'upload_failed' });
    expect(warn).toHaveBeenCalledWith({ email: 'e@x.test', errName: 'TypeError' }, 'drive test upload failed');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Northwind');
  });
});
