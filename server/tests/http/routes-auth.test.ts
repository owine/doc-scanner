import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { createTestDb } from '../helpers/test-db.js';
import { ProtonAuth, TwoFactorRequiredError } from '../../src/auth/srp.js';
import { _resetSids } from '../../src/http/middleware.js';

let cleanupFn: (() => void) | null = null;
beforeEach(() => { _resetSids(); });
afterEach(() => { cleanupFn?.(); cleanupFn = null; vi.restoreAllMocks(); });

const KEY = Buffer.alloc(32, 1).toString('base64');

function setup() {
  const { db, cleanup } = createTestDb(); cleanupFn = cleanup;
  const fakeAuth = {
    login: vi.fn(),
    refresh: vi.fn(),
  } as unknown as ProtonAuth;
  const app = createApp({ db, encryptionKey: KEY, protonAuth: fakeAuth });
  return { app, fakeAuth };
}

describe('POST /api/auth/login', () => {
  it('returns 200 + sets cookie on success', async () => {
    const { app, fakeAuth } = setup();
    (fakeAuth.login as any).mockResolvedValue({ uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'e@x.test' });

    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'e@x.test', password: 'p' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(await res.json()).toMatchObject({ ok: true, email: 'e@x.test' });
  });

  it('returns 401 on bad credentials', async () => {
    const { app, fakeAuth } = setup();
    (fakeAuth.login as any).mockRejectedValue(Object.assign(new Error('bad'), { status: 401 }));
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'e@x.test', password: 'p' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 422 when 2FA required and TOTP missing', async () => {
    const { app, fakeAuth } = setup();
    (fakeAuth.login as any).mockRejectedValue(new TwoFactorRequiredError({} as any));
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'e@x.test', password: 'p' }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'totp_required' });
  });

  it('rejects malformed input with 400', async () => {
    const { app } = setup();
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: '' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/auth/status', () => {
  it('returns 401 when no session', async () => {
    const { app } = setup();
    const res = await app.request('/api/auth/status');
    expect(res.status).toBe(401);
  });

  it('returns 200 + email after login', async () => {
    const { app, fakeAuth } = setup();
    (fakeAuth.login as any).mockResolvedValue({ uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'e@x.test' });
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'e@x.test', password: 'p' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const res = await app.request('/api/auth/status', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: 'e@x.test' });
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session and cookie', async () => {
    const { app, fakeAuth } = setup();
    (fakeAuth.login as any).mockResolvedValue({ uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'e@x.test' });
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'e@x.test', password: 'p' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const logout = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } });
    expect(logout.status).toBe(200);
    const status = await app.request('/api/auth/status', { headers: { cookie } });
    expect(status.status).toBe(401);
  });
});
