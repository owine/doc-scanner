import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { _resetSids, COOKIE_MODE } from '../../src/http/middleware.js';
import { _resetLiveSessions, getLiveSession } from '../../src/auth/live-session.js';
import { ProtonApiError } from '../../src/auth/proton-api.js';
import { SessionEndedError } from '../../src/auth/srp.js';
import { KeyDecryptError, type DecryptedUserKey } from '../../src/auth/keys.js';
import { logger } from '../../src/logger.js';
import { PasskeyStore } from '../../src/auth/passkey-store.js';
import { SETTING, deleteSetting, writeSetting } from '../../src/auth/app-settings.js';
import {
  CRED,
  CRED_2,
  LABEL,
  PASSPHRASE,
  PRF_B64,
  SESSION,
  authApp,
  makeKeys,
  post,
  resumeResult,
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

/** Locked: Proton tokens stored, a passkey enrolled (with its fingerprint), no live session (a restart). */
function locked(opts: Parameters<typeof authApp>[0] = {}): AuthApp {
  const a = authApp(opts);
  apps.push(a);
  a.store.save(SESSION);
  seedPasskey(a.passkeys);
  writeSetting(a.db, SETTING.keySaltFingerprint, 'fp-enrolled');
  return a;
}

const unlock = (c: AuthApp, body: Record<string, unknown> = { credentialId: CRED, prf: PRF_B64 }) => post(c.app, '/api/auth/unlock', body);
const LIVE_STATUS = { email: 'e@x.test', proton: 'live', passkeys: 1, unlockAvailable: true };

function deferredResume(c: AuthApp): () => void {
  let release!: () => void;
  c.auth.resume.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve(resumeResult(keys));
      }),
  );
  return () => release();
}

describe('POST /api/auth/unlock/begin', () => {
  it('lists every passkey with its salt', async () => {
    const c = locked();
    seedPasskey(c.passkeys, CRED_2);
    const res = await post(c.app, '/api/auth/unlock/begin');
    expect(await res.json()).toEqual({
      credentials: [
        { credentialId: CRED, salt: Buffer.alloc(32, 3).toString('base64url') },
        { credentialId: CRED_2, salt: Buffer.alloc(32, 3).toString('base64url') },
      ],
    });
  });

  it('answers 409 with no passkeys', async () => {
    const c = authApp();
    apps.push(c);
    const res = await post(c.app, '/api/auth/unlock/begin');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no_passkeys' });
  });
});

describe('POST /api/auth/unlock', () => {
  it('opens the keys with the unwrapped passphrase, starts the live session and records the use', async () => {
    const c = locked();
    c.auth.resume.mockResolvedValue(resumeResult(keys));
    const res = await unlock(c);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(LIVE_STATUS);
    const [session, passphrase, opts] = c.auth.resume.mock.calls[0]!;
    expect(session).toEqual(SESSION);
    expect(new TextDecoder().decode(passphrase as Uint8Array)).toBe(PASSPHRASE);
    expect(opts).toEqual({ onRefreshed: expect.any(Function) });
    // The fingerprint recorded at enrolment: the passphrase that opened the keys proves the salt unchanged.
    expect(getLiveSession('proxy')).toMatchObject({ userId: 'user-1', keySaltFingerprint: 'fp-enrolled' });
    expect(c.passkeys.list()[0]?.lastUsedAt).not.toBeNull();
  });

  it('starts the session with no fingerprint when none is recorded', async () => {
    const c = locked();
    deleteSetting(c.db, SETTING.keySaltFingerprint);
    c.auth.resume.mockResolvedValue(resumeResult(keys));
    expect((await unlock(c)).status).toBe(200);
    expect(getLiveSession('proxy')?.keySaltFingerprint).toBeNull();
  });

  it('answers with the status, without touching Proton, when already live', async () => {
    const c = locked();
    await signIn(c, keys, { keySaltFingerprint: 'fp-enrolled' });
    const res = await unlock(c);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(LIVE_STATUS);
    expect(c.auth.resume).not.toHaveBeenCalled();
  });

  it('needs stored Proton tokens', async () => {
    const c = locked();
    c.store.clear();
    const res = await unlock(c);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'proton_login_required' });
  });

  it('answers 404 for a passkey it does not know, and 401 for a wrong PRF output', async () => {
    const c = locked();
    const unknown = await unlock(c, { credentialId: CRED_2, prf: PRF_B64 });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown_passkey' });
    const wrong = await unlock(c, { credentialId: CRED, prf: Buffer.alloc(32, 8).toString('base64url') });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'unlock_failed' });
    expect(c.auth.resume).not.toHaveBeenCalled();
  });

  it('refuses a malformed request', async () => {
    const c = locked();
    for (const body of [{ credentialId: 'short', prf: PRF_B64 }, { credentialId: CRED, prf: Buffer.alloc(16).toString('base64url') }, {}]) {
      expect((await unlock(c, body)).status).toBe(400);
    }
  });

  it('answers passkey_unreadable and removes only that passkey when its wrap will not open', async () => {
    const c = locked();
    seedPasskey(c.passkeys, CRED_2);
    c.db.prepare('UPDATE passkey_unlocks SET wrapped = ? WHERE credential_id = ?').run(new Uint8Array(60), CRED);
    const res = await unlock(c);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'passkey_unreadable' });
    expect(c.passkeys.list().map((p) => p.credentialId)).toEqual([CRED_2]);
  });

  it('saves refreshed tokens and starts the live session with them', async () => {
    const c = locked();
    const refreshed = { ...SESSION, accessToken: 'a2', refreshToken: 'r2' };
    c.auth.resume.mockImplementation(async (_s: unknown, _p: unknown, opts: { onRefreshed: (s: typeof SESSION) => void }) => {
      opts.onRefreshed(refreshed);
      return resumeResult(keys, { session: refreshed });
    });
    expect((await unlock(c)).status).toBe(200);
    expect(c.store.load()).toEqual(refreshed);
    expect(getLiveSession('proxy')?.session).toEqual(refreshed);
  });

  it('keeps refreshed tokens saved when the retry then fails, and answers 503', async () => {
    const c = locked();
    const refreshed = { ...SESSION, accessToken: 'a2', refreshToken: 'r2' };
    c.auth.resume.mockImplementation(async (_s: unknown, _p: unknown, opts: { onRefreshed: (s: typeof SESSION) => void }) => {
      opts.onRefreshed(refreshed);
      throw new ProtonApiError('HTTP 503', 503);
    });
    const res = await unlock(c);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'proton_unavailable' });
    expect(c.store.load()).toEqual(refreshed);
  });

  it('clears the stored session but keeps the passkeys when Proton ended the session', async () => {
    const c = locked();
    c.auth.resume.mockRejectedValue(new SessionEndedError(new ProtonApiError('Invalid refresh token', 400)));
    const res = await unlock(c);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'proton_login_required' });
    expect(c.store.load()).toBeNull();
    expect(c.passkeys.count()).toBe(1);
  });

  for (const [label, error] of [
    ['a network error', new TypeError('fetch failed')],
    ['a 5xx', new ProtonApiError('HTTP 502', 502)],
    ['rate limiting', new ProtonApiError('Too many requests', 429)],
  ] as const) {
    it(`answers 503 and changes nothing on ${label}`, async () => {
      const c = locked();
      c.auth.resume.mockRejectedValue(error);
      const res = await unlock(c);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'proton_unavailable' });
      expect(c.store.load()).toEqual(SESSION);
      expect(c.passkeys.count()).toBe(1);
      expect(getLiveSession('proxy')).toBeUndefined();
    });
  }

  it('removes every passkey when the passphrase no longer opens the user key', async () => {
    const c = locked();
    seedPasskey(c.passkeys, CRED_2);
    c.auth.resume.mockRejectedValue(new KeyDecryptError('Failed to decrypt user key k1', 'user_key'));
    const res = await unlock(c);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'passkeys_stale' });
    expect(c.passkeys.count()).toBe(0);
    expect(c.store.load()).toEqual(SESSION);
  });

  for (const reason of ['key_unreadable', 'no_keys', 'no_addresses', 'address_key'] as const) {
    it(`removes nothing on a ${reason} key failure`, async () => {
      const c = locked();
      c.auth.resume.mockRejectedValue(new KeyDecryptError('x', reason));
      expect((await unlock(c)).status).toBe(500);
      expect(c.passkeys.count()).toBe(1);
    });
  }

  it('zeroes the passphrase when reading the recorded fingerprint fails', async () => {
    const c = locked();
    c.auth.resume.mockResolvedValue(resumeResult(keys));
    const prepare = c.db.prepare.bind(c.db);
    vi.spyOn(c.db, 'prepare').mockImplementation((s: string) => {
      if (/^SELECT value FROM app_settings/.test(s)) throw new Error('disk I/O error');
      return prepare(s);
    });
    expect((await unlock(c)).status).toBe(500);
    const passphrase = c.auth.resume.mock.calls[0]![1] as Uint8Array;
    expect(passphrase.every((b) => b === 0)).toBe(true);
    expect(getLiveSession('proxy')).toBeUndefined();
  });

  it('still answers 200 when recording the use fails', async () => {
    const c = locked();
    c.auth.resume.mockResolvedValue(resumeResult(keys));
    vi.spyOn(PasskeyStore.prototype, 'touch').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    const warn = vi.spyOn(logger, 'warn');
    const res = await unlock(c);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(LIVE_STATUS);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ errName: 'Error' }), expect.any(String));
  });

  it('resumes documents awaiting login through the live-session listener', async () => {
    const c = locked({ pipeline: true });
    const pipeline = c.pipeline!;
    vi.spyOn(pipeline.worker, 'start').mockImplementation(() => {});
    vi.spyOn(pipeline.worker, 'wake').mockResolvedValue();
    pipeline.start();
    const doc = pipeline.repo.insert({ source: 'picker', originalName: 'a.pdf', mime: 'application/pdf', size: 1, sha256: 'aw', sourceContext: null });
    pipeline.repo.transition(doc.id, 'received', 'awaiting_login');
    c.auth.resume.mockResolvedValue(resumeResult(keys));
    expect((await unlock(c)).status).toBe(200);
    await vi.waitFor(() => expect(pipeline.repo.get(doc.id)?.state).toBe('filing'));
  });

  it('runs two concurrent unlocks one after the other: the second finds the session live', async () => {
    const c = locked();
    const release = deferredResume(c);
    const first = unlock(c);
    const second = unlock(c);
    await vi.waitFor(() => expect(c.auth.resume).toHaveBeenCalledTimes(1));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await b.json()).toEqual(LIVE_STATUS);
    expect(c.auth.resume).toHaveBeenCalledTimes(1);
  });

  it('gives a login queued behind an unlock its own result: a wrong password still fails', async () => {
    const c = locked();
    const release = deferredResume(c);
    c.auth.login.mockRejectedValue(Object.assign(new Error('bad'), { status: 401 }));
    const unlocking = unlock(c);
    await vi.waitFor(() => expect(c.auth.resume).toHaveBeenCalled());
    const login = post(c.app, '/api/auth/login', { email: 'e@x.test', password: 'wrong' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(c.auth.login).not.toHaveBeenCalled();
    release();
    expect((await unlocking).status).toBe(200);
    const res = await login;
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'auth_failed' });
  });

  it('needs the proxy user', async () => {
    const c = locked();
    expect((await post(c.app, '/api/auth/unlock', { credentialId: CRED, prf: PRF_B64 }, {})).status).toBe(401);
    expect((await post(c.app, '/api/auth/unlock/begin', undefined, {})).status).toBe(401);
  });

  it('does not exist in cookie mode', async () => {
    const c = locked({ mode: COOKIE_MODE });
    expect((await post(c.app, '/api/auth/unlock/begin', undefined, {})).status).toBe(404);
    expect((await post(c.app, '/api/auth/unlock', { credentialId: CRED, prf: PRF_B64 }, {})).status).toBe(404);
  });
});

describe('enrolling, then unlocking after a restart', () => {
  it('gets the same passphrase back, and logs no secret', async () => {
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(logger, level));
    const c = authApp();
    apps.push(c);
    await signIn(c, keys);
    const { salt } = (await (await post(c.app, '/api/passkeys/begin')).json()) as { salt: string };
    expect((await post(c.app, '/api/passkeys', { credentialId: CRED, salt, prf: PRF_B64, label: LABEL })).status).toBe(201);
    // A wrong attempt too, so its log line is checked as well.
    await unlock(c, { credentialId: CRED, prf: Buffer.alloc(32, 8).toString('base64url') });

    // The restart: no live session; the stored tokens and the passkey remain.
    _resetLiveSessions();
    c.auth.resume.mockResolvedValue(resumeResult(keys));
    expect((await unlock(c)).status).toBe(200);
    expect(new TextDecoder().decode(c.auth.resume.mock.calls[0]![1] as Uint8Array)).toBe(PASSPHRASE);

    const logged = JSON.stringify(spies.map((s) => s.mock.calls));
    for (const secret of [PRF_B64, Buffer.alloc(32, 8).toString('base64url'), LABEL, PASSPHRASE, salt, CRED]) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).toContain(CRED.slice(0, 8));
  });
});
