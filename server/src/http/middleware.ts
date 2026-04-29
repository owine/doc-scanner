import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { randomBytes } from 'node:crypto';
import type { SessionStore } from '../auth/session-store.js';
import { getLiveSession, disposeLiveSession, type LiveSession } from '../auth/live-session.js';

export const COOKIE_NAME = 'docscanner_sid';

// In-memory map: cookie sid -> "logged in" marker. The actual Proton session
// lives in SessionStore (encrypted, persistent). This map exists only to bind
// a browser cookie to "this server has a session loaded for it"; it resets on
// restart, which forces re-login by-design (P1 single-user behavior).
const liveSids = new Set<string>();

export interface AuthContext {
  email: string;
  sid: string;
  liveSession?: LiveSession;
}

type Env = { Variables: { auth?: AuthContext } };

export const sessionMiddleware = (store: SessionStore): MiddlewareHandler<Env> => async (c, next) => {
  const sid = getCookie(c, COOKIE_NAME);
  if (sid && liveSids.has(sid)) {
    const session = store.load();
    if (session) {
      const liveSession = getLiveSession(sid);
      c.set('auth', { email: session.email, sid, liveSession });
    }
  }
  await next();
};

export function issueSession(c: Context<Env>, secureCookie: boolean = true): string {
  const sid = randomBytes(32).toString('base64url');
  liveSids.add(sid);
  setCookie(c, COOKIE_NAME, sid, {
    httpOnly: true, sameSite: 'Strict', secure: secureCookie, path: '/',
  });
  return sid;
}

export function revokeSession(c: Context<Env>): void {
  const sid = getCookie(c, COOKIE_NAME);
  if (sid) {
    liveSids.delete(sid);
    disposeLiveSession(sid);
  }
  deleteCookie(c, COOKIE_NAME, { path: '/' });
}

// For tests: reset the in-memory sid set
export function _resetSids(): void { liveSids.clear(); }
