import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { _resetSids, COOKIE_MODE } from '../../src/http/middleware.js';
import { _resetLiveSessions, registerLiveSession } from '../../src/auth/live-session.js';
import { MailboxSecret } from '../../src/auth/secrets/mailbox-password.js';
import type { DriveClient } from '../../src/drive/client.js';
import { PasskeyStore } from '../../src/auth/passkey-store.js';
import { SETTING, readSetting, writeSetting } from '../../src/auth/app-settings.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import {
  CRED,
  CRED_2,
  LABEL,
  PASSPHRASE,
  PRF,
  PRF_B64,
  SESSION,
  authApp,
  del,
  get,
  makeKeys,
  post,
  seedPasskey,
  signIn,
  type AuthApp,
} from '../helpers/auth-app.js';

let keys: DecryptedUserKey;
const apps: AuthApp[] = [];

beforeAll(async () => {
  keys = await makeKeys();
});
beforeEach(() => {
  _resetSids();
  _resetLiveSessions();
});
afterEach(() => {
  for (const a of apps.splice(0)) a.cleanup();
  vi.restoreAllMocks();
});

function setup(opts: Parameters<typeof authApp>[0] = {}): AuthApp {
  const a = authApp(opts);
  apps.push(a);
  return a;
}

async function live(): Promise<AuthApp> {
  const c = setup();
  await signIn(c, keys);
  return c;
}

async function begin(c: AuthApp): Promise<{ salt: string; userHandle: string; excludeCredentials: string[] }> {
  const res = await post(c.app, '/api/passkeys/begin');
  expect(res.status).toBe(200);
  return res.json();
}

const add = (c: AuthApp, body: Record<string, unknown>) => post(c.app, '/api/passkeys', body);
const text = (r: unknown) => (r instanceof Uint8Array ? new TextDecoder().decode(r) : r);

describe('passkey enrolment', () => {
  it('begins with a fresh salt, a stable user handle and the passkeys to exclude', async () => {
    const c = await live();
    seedPasskey(c.passkeys);
    const first = await begin(c);
    const second = await begin(c);
    expect(Buffer.from(first.salt, 'base64url')).toHaveLength(32);
    expect(second.salt).not.toBe(first.salt);
    expect(Buffer.from(first.userHandle, 'base64url')).toHaveLength(16);
    expect(second.userHandle).toBe(first.userHandle);
    expect(first.excludeCredentials).toEqual([CRED]);
  });

  it('wraps the live passphrase for the passkey and records the key-salt fingerprint', async () => {
    const c = await live();
    const { salt } = await begin(c);
    const res = await add(c, { credentialId: CRED, salt, prf: PRF_B64, label: LABEL });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ credentialId: CRED, label: LABEL, lastUsedAt: null });
    expect(text(c.passkeys.unwrap(CRED, PRF))).toBe(PASSPHRASE);
    expect(readSetting(c.db, SETTING.keySaltFingerprint)).toBe('fp-1');
  });

  it('keeps the recorded fingerprint when the live session knows none', async () => {
    const c = setup();
    // As after an unlock with no fingerprint recorded.
    registerLiveSession({
      sid: 'proxy',
      session: SESSION,
      mailboxSecret: new MailboxSecret(new TextEncoder().encode(PASSPHRASE)),
      decryptedKeys: keys,
      driveClient: {} as DriveClient,
      userId: 'user-1',
      keySaltFingerprint: null,
    });
    writeSetting(c.db, SETTING.keySaltFingerprint, 'fp-stored');
    const { salt } = await begin(c);
    expect((await add(c, { credentialId: CRED, salt, prf: PRF_B64 })).status).toBe(201);
    expect(readSetting(c.db, SETTING.keySaltFingerprint)).toBe('fp-stored');
  });

  it('needs live Proton keys', async () => {
    const c = setup();
    for (const res of [await post(c.app, '/api/passkeys/begin'), await add(c, { credentialId: CRED, salt: 'x', prf: PRF_B64 })]) {
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'proton_not_live' });
    }
  });

  it('refuses an unknown, a used or an expired salt', async () => {
    const c = await live();
    const unknown = await add(c, { credentialId: CRED, salt: Buffer.alloc(32, 1).toString('base64url'), prf: PRF_B64 });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: 'invalid_enrolment' });

    const { salt } = await begin(c);
    expect((await add(c, { credentialId: CRED, salt, prf: PRF_B64 })).status).toBe(201);
    const reused = await add(c, { credentialId: CRED_2, salt, prf: PRF_B64 });
    expect(reused.status).toBe(400);
    expect(await reused.json()).toEqual({ error: 'invalid_enrolment' });

    const late = await begin(c);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000);
    const expired = await add(c, { credentialId: CRED_2, salt: late.salt, prf: PRF_B64 });
    expect(await expired.json()).toEqual({ error: 'invalid_enrolment' });
  });

  it('zeroes the decoded PRF output after adding, and after a failed add', async () => {
    const c = await live();
    const added = vi.spyOn(PasskeyStore.prototype, 'add');
    expect((await add(c, { credentialId: CRED, salt: (await begin(c)).salt, prf: PRF_B64 })).status).toBe(201);
    added.mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    expect((await add(c, { credentialId: CRED_2, salt: (await begin(c)).salt, prf: PRF_B64 })).status).toBe(500);
    expect(added).toHaveBeenCalledTimes(2);
    for (const [entry] of added.mock.calls) expect(entry.prf.every((b) => b === 0)).toBe(true);
  });

  it('refuses to enrol a credential id again, and keeps its wrap', async () => {
    const c = await live();
    expect((await add(c, { credentialId: CRED, salt: (await begin(c)).salt, prf: PRF_B64, label: LABEL })).status).toBe(201);
    const again = await add(c, { credentialId: CRED, salt: (await begin(c)).salt, prf: Buffer.alloc(32, 9).toString('base64url'), label: 'other' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'already_enrolled' });
    expect(text(c.passkeys.unwrap(CRED, PRF))).toBe(PASSPHRASE);
    expect(c.passkeys.list().map((p) => p.label)).toEqual([LABEL]);
  });

  it('keeps at most 16 pending salts, forgetting the oldest first', async () => {
    const c = await live();
    const salts: string[] = [];
    for (let i = 0; i < 17; i++) salts.push((await begin(c)).salt);
    const oldest = await add(c, { credentialId: CRED, salt: salts[0], prf: PRF_B64 });
    expect(await oldest.json()).toEqual({ error: 'invalid_enrolment' });
    expect((await add(c, { credentialId: CRED, salt: salts[1], prf: PRF_B64 })).status).toBe(201);
    expect((await add(c, { credentialId: CRED_2, salt: salts[16], prf: PRF_B64 })).status).toBe(201);
  });

  it('loses a pending salt to a restart', async () => {
    const c = await live();
    const { salt } = await begin(c);
    // The same database, a new process: the live session survives only because tests share module state.
    const restarted = setup({ db: c.db });
    const res = await post(restarted.app, '/api/passkeys', { credentialId: CRED, salt, prf: PRF_B64 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_enrolment' });
  });

  it('refuses a PRF output that is not 32 bytes, and a malformed credential id', async () => {
    const c = await live();
    const { salt } = await begin(c);
    const short = await add(c, { credentialId: CRED, salt, prf: Buffer.alloc(16, 7).toString('base64url') });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: 'invalid_input' });
    for (const credentialId of ['short', 'has spaces in it, sixteen+', 'a/b/c/d/e/f/g/h/i/j', 'x'.repeat(257)]) {
      const res = await add(c, { credentialId, salt, prf: PRF_B64 });
      expect([credentialId, res.status]).toEqual([credentialId, 400]);
    }
    // Still pending: nothing above consumed it.
    expect((await add(c, { credentialId: CRED, salt, prf: PRF_B64 })).status).toBe(201);
  });

  it('trims and caps the label, and names an empty one "Passkey"', async () => {
    const c = await live();
    const long = await (await add(c, { credentialId: CRED, salt: (await begin(c)).salt, prf: PRF_B64, label: `  ${'é'.repeat(80)}  ` })).json();
    expect(long.label).toBe('é'.repeat(60));
    const empty = await (await add(c, { credentialId: CRED_2, salt: (await begin(c)).salt, prf: PRF_B64, label: '   ' })).json();
    expect(empty.label).toBe('Passkey');
  });
});

describe('listing and removing passkeys', () => {
  it('lists the passkeys, and says once that a password change removed them', async () => {
    const c = setup();
    seedPasskey(c.passkeys);
    const list = await (await get(c.app, '/api/passkeys')).json();
    expect(list).toEqual({ passkeys: [{ credentialId: CRED, label: LABEL, createdAt: expect.any(String), lastUsedAt: null }], notice: null });
    writeSetting(c.db, SETTING.removedNotice, 'password_changed');
    expect((await (await get(c.app, '/api/passkeys')).json()).notice).toBe('password_changed');
    expect((await (await get(c.app, '/api/passkeys')).json()).notice).toBeNull();
  });

  it('removes one passkey, then answers 404', async () => {
    const c = setup();
    seedPasskey(c.passkeys);
    expect((await del(c.app, `/api/passkeys/${CRED}`)).status).toBe(204);
    expect(c.passkeys.count()).toBe(0);
    expect((await del(c.app, `/api/passkeys/${CRED}`)).status).toBe(404);
    expect((await del(c.app, '/api/passkeys/bad')).status).toBe(404);
  });

  it('needs the proxy user', async () => {
    const c = setup();
    expect((await get(c.app, '/api/passkeys', {})).status).toBe(401);
    expect((await del(c.app, `/api/passkeys/${CRED}`, {})).status).toBe(401);
  });
});

describe('passkey routes in cookie mode', () => {
  it('do not exist', async () => {
    const c = setup({ mode: COOKIE_MODE });
    for (const res of [
      await post(c.app, '/api/passkeys/begin', undefined, {}),
      await post(c.app, '/api/passkeys', { credentialId: CRED, salt: 'x', prf: PRF_B64 }, {}),
      await get(c.app, '/api/passkeys', {}),
      await del(c.app, `/api/passkeys/${CRED}`, {}),
    ]) {
      expect(res.status).toBe(404);
    }
  });
});
