import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import type { SessionStore } from '../auth/session-store.js';
import { getLiveSession, disposeAllLiveSessions, type LiveSession } from '../auth/live-session.js';

export const COOKIE_NAME = 'docscanner_sid';

/** Header mode's one live-session id: the proxy, not a cookie, says who the user is. */
export const PROXY_SID = 'proxy';

/** Sent by the proxy when AUTH_PROXY_SECRET is set (passkey-unlock spec §1). */
export const PROXY_SECRET_HEADER = 'X-Doc-Scanner-Proxy-Secret';

/**
 * How a request is signed in. Cookie mode (development): the app's own
 * session cookie, issued by a Proton login. Header mode: the reverse proxy's
 * `Remote-User` equals `user` (and, with a secret, the request carries it).
 */
export type AuthMode = { kind: 'cookie' } | { kind: 'header'; user: string; secret: string | null };

export const COOKIE_MODE: AuthMode = { kind: 'cookie' };

export function authModeFrom(config: Pick<Config, 'AUTH_PROXY_USER' | 'AUTH_PROXY_SECRET'>): AuthMode {
  if (config.AUTH_PROXY_USER === undefined) return COOKIE_MODE;
  return { kind: 'header', user: config.AUTH_PROXY_USER, secret: config.AUTH_PROXY_SECRET ?? null };
}

// Cookie mode only. In-memory map: cookie sid -> "logged in" marker. The
// actual Proton session lives in SessionStore (encrypted, persistent). This
// map exists only to bind a browser cookie to "this server has a session
// loaded for it"; it resets on restart, which forces re-login by design.
const liveSids = new Set<string>();

export interface AuthContext {
  email: string;
  sid: string;
  liveSession?: LiveSession;
}

type Env = { Variables: { auth?: AuthContext } };

/** Methods that change state: header mode refuses them from another site. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Compares SHA-256 digests: equal lengths for timingSafeEqual, whatever was sent. */
function secretMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(digest(given), digest(expected));
}

export const sessionMiddleware = (store: SessionStore, mode: AuthMode = COOKIE_MODE): MiddlewareHandler<Env> => async (c, next) => {
  if (mode.kind === 'header') {
    // The app's own SameSite=Strict cookie used to stop cross-site requests;
    // Authelia's cookie is usually Lax. Browsers send Sec-Fetch-Site on every
    // request; a client without it (curl) is not a browser being tricked.
    const site = c.req.header('Sec-Fetch-Site');
    if (UNSAFE_METHODS.has(c.req.method) && site !== undefined && site !== 'same-origin') {
      return c.json({ error: 'cross_site' }, 403);
    }
    if (c.req.header('Remote-User') === mode.user && (mode.secret === null || secretMatches(c.req.header(PROXY_SECRET_HEADER), mode.secret))) {
      c.set('auth', {
        email: store.storedEmail() ?? c.req.header('Remote-Email') ?? mode.user,
        sid: PROXY_SID,
        liveSession: getLiveSession(PROXY_SID),
      });
    }
    await next();
    return;
  }
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

/** For the auth and passkey routers: their JSON bodies are a few hundred bytes. */
export const smallBodies = (): MiddlewareHandler =>
  bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) });

/**
 * For routes that exist only in header mode (spec §1, Guards): passkeys
 * unlock after a restart, which only header mode can use. Cookie mode
 * answers 404; header mode without the proxy user, 401.
 */
export function headerOnly(mode: AuthMode): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (mode.kind !== 'header') return c.json({ error: 'not_found' }, 404);
    if (!c.get('auth')) return c.json({ error: 'not_authenticated' }, 401);
    await next();
  };
}

/** A new cookie-mode session id, not yet signed in. */
export function mintSid(): string {
  return randomBytes(32).toString('base64url');
}

/** Signs `sid` in and sets its cookie: only once its live session has started. */
export function issueSession(c: Context<Env>, sid: string, secureCookie: boolean = true): void {
  liveSids.add(sid);
  setCookie(c, COOKIE_NAME, sid, {
    httpOnly: true, sameSite: 'Strict', secure: secureCookie, path: '/',
  });
}

/**
 * Logout's in-memory part. The session store holds a single row and logout
 * clears it, so this means "logged out everywhere": every sid is forgotten
 * and every live session is disposed, so nothing (the document worker
 * included) can keep using, or refresh the tokens of, a login that no longer
 * exists.
 */
export function forgetAllSessions(): void {
  liveSids.clear();
  disposeAllLiveSessions();
}

/** Cookie-mode logout: forgets every session and deletes the cookie. */
export function revokeAllSessions(c: Context<Env>): void {
  forgetAllSessions();
  deleteCookie(c, COOKIE_NAME, { path: '/' });
}

// For tests: reset the in-memory sid set
export function _resetSids(): void { liveSids.clear(); }
