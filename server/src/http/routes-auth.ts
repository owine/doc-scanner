import { Hono } from 'hono';
import { z } from 'zod';
import { TwoFactorRequiredError, type ProtonAuth, type ProtonSession } from '../auth/srp.js';
import type { SessionStore } from '../auth/session-store.js';
import type { DecryptedUserKey } from '../auth/keys.js';
import type { MailboxSecret } from '../auth/secrets/mailbox-password.js';
import type { PasskeyStore } from '../auth/passkey-store.js';
import { SETTING, deleteSetting, readSetting, writeSetting } from '../auth/app-settings.js';
import { Mutex } from '../auth/mutex.js';
import {
  PROXY_SID,
  forgetAllSessions,
  issueSession,
  revokeAllSessions,
  sessionMiddleware,
  type AuthContext,
  type AuthMode,
} from './middleware.js';
import { logger } from '../logger.js';
import { captureAuthFailure } from '../observability/report.js';
import { DriveClient } from '../drive/client.js';
import { getAnyLiveSession, getLiveSession, registerLiveSession } from '../auth/live-session.js';
import type { DB } from '../db.js';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

type Env = { Variables: { auth?: AuthContext } };

/** GET /status (passkey-unlock spec §1). Unlock answers with it too. */
export interface AuthStatus {
  email: string;
  /** `live`: keys in memory. `locked`: tokens stored, no keys. `none`: nothing stored. */
  proton: 'live' | 'locked' | 'none';
  passkeys: number;
  /** Header mode only: the PWA hides every passkey control otherwise. */
  unlockAvailable: boolean;
}

export interface AuthRoutesDeps {
  store: SessionStore;
  protonAuth: ProtonAuth;
  db: DB;
  encryptionKey: string;
  passkeys: PasskeyStore;
  authMode: AuthMode;
  /** Forgets what belongs to a previous Proton account outside the auth tables (the folder cache). */
  clearAccountData: () => void;
  appVersion?: string;
  secureCookie?: boolean;
}

export function authRoutes(deps: AuthRoutesDeps) {
  const header = deps.authMode.kind === 'header';
  const r = new Hono<Env>();
  r.use('*', sessionMiddleware(deps.store, deps.authMode));

  // Login, unlock and logout take turns: two Proton calls at once could each
  // refresh the one refresh token, and Proton would reject the second.
  const mutex = new Mutex();

  function status(email: string, sid: string): AuthStatus {
    const proton = getLiveSession(sid) ? 'live' : deps.store.storedEmail() !== null ? 'locked' : 'none';
    return { email, proton, passkeys: deps.passkeys.count(), unlockAvailable: header };
  }

  /**
   * Builds the Drive client and registers the live session. Registering
   * runs the onLiveSessionRegistered listeners, so the worker resumes what
   * waited for a login (pipeline.ts). Login and unlock both start here. On a
   * failure the passphrase is disposed: no session will ever own it.
   */
  async function startLiveSession(s: {
    sid: string;
    session: ProtonSession;
    mailboxSecret: MailboxSecret;
    decryptedKeys: DecryptedUserKey;
    userId: string;
    keySaltFingerprint: string;
    /** Another Proton account: clear the entities and event-id caches before the session can use them. */
    clearDriveCaches?: boolean;
  }): Promise<void> {
    try {
      await registerNewSession(s);
    } catch (err) {
      s.mailboxSecret.dispose();
      throw err;
    }
  }

  async function registerNewSession(s: Parameters<typeof startLiveSession>[0]): Promise<void> {
    const driveClient = new DriveClient({
      db: deps.db,
      encryptionKey: deps.encryptionKey,
      appVersion: deps.appVersion ?? 'external-drive-docscanner@0.1.0',
      user: s.decryptedKeys,
      session: s.session,
      protonAuth: deps.protonAuth,
      // The SDK's HTTP adapter refreshes the access token on a 401. Persist
      // the rotated tokens, or the next process restart resumes with a
      // refresh token Proton has already invalidated.
      onSessionRefreshed: (session) => {
        deps.store.save(session);
        logger.info({ email: session.email }, 'proton session refreshed');
      },
    });
    // They are not account-scoped; the new client clears the shared tables.
    if (s.clearDriveCaches) await driveClient.clearCaches();
    registerLiveSession({
      sid: s.sid,
      session: s.session,
      mailboxSecret: s.mailboxSecret,
      decryptedKeys: s.decryptedKeys,
      driveClient,
      userId: s.userId,
      keySaltFingerprint: s.keySaltFingerprint,
    });
  }

  /**
   * A changed key salt means a changed password: every wrap holds the old
   * passphrase (spec §1). Says so to Settings only if a passkey was removed.
   */
  function dropStalePasskeys(fingerprint: string): void {
    const stored = readSetting(deps.db, SETTING.keySaltFingerprint);
    if (stored === null || stored === fingerprint) return;
    const removed = deps.passkeys.removeAll();
    deleteSetting(deps.db, SETTING.keySaltFingerprint);
    if (removed > 0) writeSetting(deps.db, SETTING.removedNotice, 'password_changed');
    logger.info({ removed }, 'proton key salt changed; passkey unlocks removed');
  }

  r.post('/login', async (c) => {
    // Header mode: only the proxy's user may start a Proton session.
    if (header && !c.get('auth')) return c.json({ error: 'not_authenticated' }, 401);
    const parseResult = LoginSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parseResult.success) return c.json({ error: 'invalid_input' }, 400);

    const { email, password, totp } = parseResult.data;
    const remoteUser = c.req.header('Remote-User');
    return mutex.run(async (): Promise<Response> => {
      // ProtonAuth.login reports its own failures (and knows which are typos);
      // this only covers what fails after Proton has accepted the login.
      let loggedIn = false;
      try {
        const result = await deps.protonAuth.login(email, password, totp);
        loggedIn = true;
        // Never a logout first: it would remove the passkeys. Compared by
        // User.ID, since one account can be typed as different emails.
        const previousUserId = readSetting(deps.db, SETTING.protonUserId);
        const otherAccount = previousUserId !== null && previousUserId !== result.userId;
        if (otherAccount) {
          // First the old account's live session, before the new tokens are
          // stored: a failure below must never leave A's keys beside B's tokens.
          forgetAllSessions();
          deps.clearAccountData();
          deps.passkeys.removeAll();
          deleteSetting(deps.db, SETTING.keySaltFingerprint);
          deleteSetting(deps.db, SETTING.removedNotice);
          logger.info('a different proton account signed in; cleared the previous account data');
        } else {
          dropStalePasskeys(result.keySaltFingerprint);
        }
        deps.store.save(result.session);
        // Header mode keeps one live session, which each login replaces; no cookie.
        const sid = header ? PROXY_SID : issueSession(c, deps.secureCookie ?? true);
        await startLiveSession({
          sid,
          session: result.session,
          mailboxSecret: result.mailboxSecret,
          decryptedKeys: result.decryptedKeys,
          userId: result.userId,
          keySaltFingerprint: result.keySaltFingerprint,
          clearDriveCaches: otherAccount,
        });
        // Last: if anything above failed, the next login still sees the old account and clears again.
        writeSetting(deps.db, SETTING.protonUserId, result.userId);
        logger.info({ email, remoteUser }, 'login succeeded');
        return c.json({ ok: true, email: result.session.email });
      } catch (e) {
        if (e instanceof TwoFactorRequiredError) return c.json({ error: 'totp_required' }, 422);
        if (loggedIn) captureAuthFailure(e, 'login', 'session');
        const status = (e as { status?: number }).status === 401 ? 401 : 500;
        logger.warn({ email, err: (e as Error).message }, 'login failed');
        return c.json({ error: 'auth_failed', reauth_required: true }, status as 401 | 500);
      }
    });
  });

  r.post('/logout', async (c) => {
    // Header mode: only the proxy's user may forget the Proton session.
    if (header && !c.get('auth')) return c.json({ error: 'not_authenticated' }, 401);
    // In turn: an unlock finishing after this would bring the session back.
    return mutex.run(async (): Promise<Response> => {
      // Drop the SDK's persisted caches before the live session goes away. They
      // are not account-scoped, so leaving them behind would serve one account's
      // entities to whoever logs in next.
      // Fall back to any live session so a stale or missing cookie still clears them.
      const driveClient = c.get('auth')?.liveSession?.driveClient ?? getAnyLiveSession()?.driveClient;
      if (driveClient) {
        try {
          await driveClient.clearCaches();
        } catch (err) {
          // Log the full error (pino's default err serializer keeps type + stack)
          // so a cache/DB failure on logout is diagnosable in production.
          logger.warn({ err }, 'failed to clear drive caches on logout');
        }
      }
      deps.store.clear();
      // "Sign out" means "forget my Proton access here": every wrap holds the passphrase.
      const passkeysRemoved = deps.passkeys.removeAll();
      deleteSetting(deps.db, SETTING.keySaltFingerprint);
      if (header) forgetAllSessions();
      else revokeAllSessions(c);
      logger.info({ passkeysRemoved }, 'logged out');
      return c.json({ ok: true });
    });
  });

  r.get('/status', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'not_authenticated' }, 401);
    return c.json(status(auth.email, auth.sid));
  });

  return r;
}
