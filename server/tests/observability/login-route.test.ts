import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as openpgp from 'openpgp';
import { createApp } from '../../src/http/server.js';
import { createTestDb } from '../helpers/test-db.js';
import { flushEvents, initRecordingSentry } from '../helpers/sentry-transport.js';
import { ProtonAuth } from '../../src/auth/srp.js';
import { ProtonApiError } from '../../src/auth/proton-api.js';
import { SessionStore } from '../../src/auth/session-store.js';
import { MailboxSecret } from '../../src/auth/secrets/mailbox-password.js';
import { _resetSids } from '../../src/http/middleware.js';
import { _resetLiveSessions } from '../../src/auth/live-session.js';

const { events } = initRecordingSentry();

async function loginSuccess() {
  const { privateKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'e@x.test' }], passphrase: 'p', format: 'object',
  });
  const key = await openpgp.decryptKey({ privateKey, passphrase: 'p' });
  return {
    session: { uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'e@x.test' },
    mailboxSecret: new MailboxSecret(new Uint8Array([0])),
    decryptedKeys: {
      primaryAddress: { email: 'e@x.test', addressId: 'a1' },
      primaryKey: key,
      addresses: [{ email: 'e@x.test', addressId: 'a1', keys: [{ id: 'k1', key }], primaryKeyIndex: 0 }],
    },
  };
}

describe('POST /api/auth/login failure reporting', () => {
  let cleanup: () => void;
  let app: ReturnType<typeof createApp>;
  let fakeAuth: ProtonAuth;

  beforeEach(() => {
    events.length = 0;
    _resetSids();
    _resetLiveSessions();
    const test = createTestDb();
    cleanup = test.cleanup;
    fakeAuth = { login: vi.fn(), refresh: vi.fn() } as unknown as ProtonAuth;
    app = createApp({ db: test.db, encryptionKey: Buffer.alloc(32, 1).toString('base64'), protonAuth: fakeAuth });
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const login = () => app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'e@x.test', password: 'p' }),
  });

  it('reports a failure after Proton accepted the login (session setup), tagged session', async () => {
    vi.mocked(fakeAuth.login).mockResolvedValue(await loginSuccess());
    vi.spyOn(SessionStore.prototype, 'save').mockImplementation(() => { throw new Error('disk full'); });

    const res = await login();
    await flushEvents();

    expect(res.status).toBe(500);
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toMatchObject({ 'auth.operation': 'login', 'auth.stage': 'session' });
  });

  it('does not report a wrong password surfacing through the route', async () => {
    vi.mocked(fakeAuth.login).mockRejectedValue(new ProtonApiError('Incorrect login credentials', 422, 8002));

    await login();
    await flushEvents();

    expect(events).toHaveLength(0);
  });
});
