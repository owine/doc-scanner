import { Hono } from 'hono';
import { z } from 'zod';
import {
  SessionEndedError,
  TwoFactorRequiredError,
  isTransientProtonError,
  type ProtonAuth,
  type ProtonSession,
  type ResumeResult,
} from '../auth/srp.js';
import type { SessionStore } from '../auth/session-store.js';
import { KeyDecryptError, type DecryptedUserKey } from '../auth/keys.js';
import { MailboxSecret } from '../auth/secrets/mailbox-password.js';
import { CREDENTIAL_ID, PRF_BYTES, decodeBase64url, shortId, type PasskeyStore } from '../auth/passkey-store.js';
import { SETTING, deleteSetting, readSetting, writeSetting } from '../auth/app-settings.js';
import { Mutex } from '../auth/mutex.js';
import {
  PROXY_SID,
  forgetAllSessions,
  headerOnly,
  issueSession,
  mintSid,
  revokeAllSessions,
  sessionMiddleware,
  type AuthContext,
  type AuthMode,
} from './middleware.js';
import { logger } from '../logger.js';
import { captureAuthFailure } from '../observability/report.js';
import { errorName } from '../observability/error-name.js';
import { DriveClient } from '../drive/client.js';
import { getAnyLiveSession, getLiveSession, registerLiveSession } from '../auth/live-session.js';
import type { DB } from '../db.js';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

const UnlockSchema = z
  .object({
    credentialId: z.string().regex(CREDENTIAL_ID),
    prf: z.string().min(1).max(100),
  })
  .strict();

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
    keySaltFingerprint: string | null;
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
    // The worker can hold a client through a long job after a login replaced
    // it or a logout forgot it. Only the registered client speaks for the
    // stored session. (False until registration, which follows clearCaches.)
    const isLive = () => getLiveSession(s.sid)?.driveClient === driveClient;
    const driveClient: DriveClient = new DriveClient({
      db: deps.db,
      encryptionKey: deps.encryptionKey,
      appVersion: deps.appVersion ?? 'external-drive-docscanner@0.1.0',
      user: s.decryptedKeys,
      session: s.session,
      protonAuth: deps.protonAuth,
      // The SDK's HTTP adapter refreshes the access token on a 401. Persist
      // the rotated tokens, or the next process restart resumes with a
      // refresh token Proton has already invalidated. A replaced client's
      // tokens would overwrite the newer login's, or undo a logout.
      onSessionRefreshed: (session) => {
        if (!isLive()) return;
        deps.store.save(session);
        logger.info({ email: session.email }, 'proton session refreshed');
      },
      // The entities table is shared: a replaced client must not write to it.
      isLive,
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
      // Owned here until startLiveSession takes it (which disposes it itself
      // on a failure); any step in between that throws must not strand it.
      let secret: MailboxSecret | undefined;
      try {
        const result = await deps.protonAuth.login(email, password, totp);
        loggedIn = true;
        secret = result.mailboxSecret;
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
        const sid = header ? PROXY_SID : mintSid();
        await startLiveSession({
          sid,
          session: result.session,
          mailboxSecret: result.mailboxSecret,
          decryptedKeys: result.decryptedKeys,
          userId: result.userId,
          keySaltFingerprint: result.keySaltFingerprint,
          clearDriveCaches: otherAccount,
        });
        secret = undefined;
        // Cookie mode: signed in only now, so a failed start leaves no cookie without a session.
        if (!header) issueSession(c, sid, deps.secureCookie ?? true);
        // Last: if anything above failed, the next login still sees the old account and clears again.
        writeSetting(deps.db, SETTING.protonUserId, result.userId);
        logger.info({ email, remoteUser }, 'login succeeded');
        return c.json({ ok: true, email: result.session.email });
      } catch (e) {
        secret?.dispose();
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
      // Read in turn: a login queued ahead of this one may have replaced the
      // session the middleware saw. Fall back to any live session so a stale
      // or missing cookie still clears the caches.
      const auth = c.get('auth');
      const driveClient = ((auth && getLiveSession(auth.sid)) ?? getAnyLiveSession())?.driveClient;
      // Forgotten first, in one synchronous run: from here no live client
      // (the worker's included) can write to the caches cleared below.
      if (header) forgetAllSessions();
      else revokeAllSessions(c);
      deps.store.clear();
      // "Sign out" means "forget my Proton access here": every wrap holds the passphrase.
      const passkeysRemoved = deps.passkeys.removeAll();
      deleteSetting(deps.db, SETTING.keySaltFingerprint);
      // Drop the SDK's persisted caches. They are not account-scoped, so
      // leaving them behind would serve one account's entities to whoever
      // logs in next.
      if (driveClient) {
        try {
          await driveClient.clearCaches();
        } catch (err) {
          // Log the full error (pino's default err serializer keeps type + stack)
          // so a cache/DB failure on logout is diagnosable in production.
          logger.warn({ err }, 'failed to clear drive caches on logout');
        }
      }
      logger.info({ passkeysRemoved }, 'logged out');
      return c.json({ ok: true });
    });
  });

  r.get('/status', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'not_authenticated' }, 401);
    return c.json(status(auth.email, auth.sid));
  });

  // Spec §2, Unlock: the salts for one passkey prompt. Header mode only.
  r.post('/unlock/begin', headerOnly(deps.authMode), (c) => {
    const credentials = deps.passkeys
      .saltsFor()
      .map((p) => ({ credentialId: p.credentialId, salt: Buffer.from(p.salt).toString('base64url') }));
    if (credentials.length === 0) return c.json({ error: 'no_passkeys' }, 409);
    return c.json({ credentials });
  });

  // Spec §2, Unlock: a PRF output opens the passphrase, which opens the keys.
  r.post('/unlock', headerOnly(deps.authMode), async (c) => {
    const auth = c.get('auth')!;
    const body = UnlockSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_input' }, 400);
    const prf = decodeBase64url(body.data.prf);
    if (!prf || prf.length !== PRF_BYTES) return c.json({ error: 'invalid_input' }, 400);
    const { credentialId } = body.data;
    const credential = shortId(credentialId);
    return mutex.run(async (): Promise<Response> => {
      // Checked in turn: an unlock queued behind another finds the work done.
      if (getLiveSession(PROXY_SID)) return c.json(status(auth.email, PROXY_SID));
      const stored = deps.store.load();
      if (!stored) return c.json({ error: 'proton_login_required' }, 409);
      const passphrase = deps.passkeys.unwrap(credentialId, prf);
      if (passphrase === 'unknown') return c.json({ error: 'unknown_passkey' }, 404);
      if (passphrase === 'wrong_secret') {
        logger.warn({ credential }, 'passkey unlock refused');
        return c.json({ error: 'unlock_failed' }, 401);
      }
      // The store has removed the row and logged it.
      if (passphrase === 'unreadable') return c.json({ error: 'passkey_unreadable' }, 409);

      let resumed: ResumeResult;
      try {
        resumed = await deps.protonAuth.resume(stored, passphrase, {
          // At once, before the retry: Proton has already invalidated the old refresh token.
          onRefreshed: (session) => {
            deps.store.save(session);
            logger.info({ email: session.email }, 'proton session refreshed');
          },
        });
      } catch (err) {
        passphrase.fill(0);
        if (err instanceof SessionEndedError) {
          // Proton ended the session. The passkeys still hold the right passphrase.
          deps.store.clear();
          logger.info({ credential }, 'passkey unlock: proton session ended');
          return c.json({ error: 'proton_login_required' }, 409);
        }
        if (isTransientProtonError(err)) {
          logger.warn({ credential, errName: errorName(err) }, 'passkey unlock: proton unavailable');
          return c.json({ error: 'proton_unavailable' }, 503);
        }
        if (err instanceof KeyDecryptError && err.reason === 'user_key') {
          // The password changed since enrolment: every wrap holds the old passphrase.
          const removed = deps.passkeys.removeAll();
          deleteSetting(deps.db, SETTING.keySaltFingerprint);
          logger.info({ credential, removed }, 'passkey unlock: passphrase no longer opens the user key; passkeys removed');
          return c.json({ error: 'passkeys_stale' }, 409);
        }
        captureAuthFailure(err, 'unlock', 'keys');
        logger.error({ credential, errName: errorName(err) }, 'passkey unlock failed');
        return c.json({ error: 'internal' }, 500);
      }
      // Recorded at enrolment and unchanged: this passphrase still opened the
      // keys. Read before the secret exists, so a failure here zeroes the bytes.
      let keySaltFingerprint: string | null;
      try {
        keySaltFingerprint = readSetting(deps.db, SETTING.keySaltFingerprint);
      } catch (err) {
        passphrase.fill(0);
        throw err;
      }
      // From here the MailboxSecret owns the bytes; logout or the next login disposes it.
      await startLiveSession({
        sid: PROXY_SID,
        session: resumed.session,
        mailboxSecret: new MailboxSecret(passphrase),
        decryptedKeys: resumed.decryptedKeys,
        userId: resumed.userId,
        keySaltFingerprint,
      });
      // The session is live: a failed bookkeeping write must not answer 500.
      try {
        deps.passkeys.touch(credentialId);
      } catch (err) {
        logger.warn({ credential, errName: errorName(err) }, 'passkey unlock: could not record the use');
      }
      logger.info({ credential }, 'unlocked with a passkey');
      return c.json(status(auth.email, PROXY_SID));
    });
  });

  return r;
}
