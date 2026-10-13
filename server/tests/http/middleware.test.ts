import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createTestDb } from '../helpers/test-db.js';
import { SessionStore } from '../../src/auth/session-store.js';
import { _resetLiveSessions } from '../../src/auth/live-session.js';
import {
  COOKIE_MODE,
  PROXY_SECRET_HEADER,
  _resetSids,
  authModeFrom,
  sessionMiddleware,
  type AuthContext,
  type AuthMode,
} from '../../src/http/middleware.js';

const KEY = Buffer.alloc(32, 1).toString('base64');
const SECRET = 's'.repeat(40);
const HEADER: AuthMode = { kind: 'header', user: 'owine', secret: null };
const WITH_SECRET: AuthMode = { kind: 'header', user: 'owine', secret: SECRET };

let cleanups: (() => void)[] = [];
beforeEach(() => {
  _resetSids();
  _resetLiveSessions();
});
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(mode: AuthMode) {
  const { db, cleanup } = createTestDb();
  cleanups.push(cleanup);
  const store = new SessionStore(db, KEY);
  const app = new Hono<{ Variables: { auth?: AuthContext } }>();
  app.use('*', sessionMiddleware(store, mode));
  app.all('/probe', (c) => c.json({ auth: c.get('auth') ?? null }));
  return { app, store };
}

type App = ReturnType<typeof setup>['app'];

async function probe(app: App, method = 'GET', headers: Record<string, string> = {}) {
  const res = await app.request('/probe', { method, headers });
  return { status: res.status, body: (await res.json()) as { auth: AuthContext | null; error?: string } };
}

describe('sessionMiddleware in header mode', () => {
  it('signs in the configured proxy user, with no cookie', async () => {
    const { app } = setup(HEADER);
    const res = await app.request('/probe', { headers: { 'Remote-User': 'owine' } });
    expect(await res.json()).toEqual({ auth: { email: 'owine', sid: 'proxy' } });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('names the user by the stored Proton email, else Remote-Email, else the user', async () => {
    const { app, store } = setup(HEADER);
    expect((await probe(app, 'GET', { 'Remote-User': 'owine', 'Remote-Email': 'me@example.test' })).body.auth?.email).toBe('me@example.test');
    store.save({ uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'e@x.test' });
    expect((await probe(app, 'GET', { 'Remote-User': 'owine', 'Remote-Email': 'me@example.test' })).body.auth?.email).toBe('e@x.test');
  });

  it('leaves a wrong or missing user signed out', async () => {
    const { app } = setup(HEADER);
    expect((await probe(app, 'GET', { 'Remote-User': 'mallory' })).body.auth).toBeNull();
    expect((await probe(app)).body.auth).toBeNull();
  });

  it('with a secret, needs the matching secret header too', async () => {
    const { app } = setup(WITH_SECRET);
    const user = { 'Remote-User': 'owine' };
    expect((await probe(app, 'GET', user)).body.auth).toBeNull();
    expect((await probe(app, 'GET', { ...user, [PROXY_SECRET_HEADER]: 't'.repeat(40) })).body.auth).toBeNull();
    // A different length must be refused, not thrown by timingSafeEqual.
    const short = await probe(app, 'GET', { ...user, [PROXY_SECRET_HEADER]: 'short' });
    expect(short).toEqual({ status: 200, body: { auth: null } });
    expect((await probe(app, 'GET', { ...user, [PROXY_SECRET_HEADER]: SECRET })).body.auth?.sid).toBe('proxy');
  });

  it('refuses a state-changing request from another site', async () => {
    const { app } = setup(HEADER);
    const user = { 'Remote-User': 'owine' };
    for (const method of ['POST', 'PUT', 'DELETE']) {
      for (const site of ['cross-site', 'same-site', 'none']) {
        const res = await probe(app, method, { ...user, 'Sec-Fetch-Site': site });
        expect([method, site, res.status, res.body]).toEqual([method, site, 403, { error: 'cross_site' }]);
      }
      expect((await probe(app, method, { ...user, 'Sec-Fetch-Site': 'same-origin' })).body.auth?.sid).toBe('proxy');
      // No header: not a browser, so not a browser being tricked into it.
      expect((await probe(app, method, user)).body.auth?.sid).toBe('proxy');
    }
    expect((await probe(app, 'GET', { ...user, 'Sec-Fetch-Site': 'cross-site' })).body.auth?.sid).toBe('proxy');
  });
});

describe('sessionMiddleware in cookie mode', () => {
  it('ignores Remote-User and does not check Sec-Fetch-Site', async () => {
    const { app } = setup(COOKIE_MODE);
    expect((await probe(app, 'GET', { 'Remote-User': 'owine' })).body.auth).toBeNull();
    expect((await probe(app, 'POST', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(200);
  });
});

describe('authModeFrom', () => {
  it('is cookie mode without a proxy user, and header mode with one', () => {
    expect(authModeFrom({ AUTH_PROXY_USER: undefined, AUTH_PROXY_SECRET: undefined })).toEqual({ kind: 'cookie' });
    expect(authModeFrom({ AUTH_PROXY_USER: 'owine', AUTH_PROXY_SECRET: undefined })).toEqual({ kind: 'header', user: 'owine', secret: null });
    expect(authModeFrom({ AUTH_PROXY_USER: 'owine', AUTH_PROXY_SECRET: SECRET })).toEqual({ kind: 'header', user: 'owine', secret: SECRET });
  });
});
