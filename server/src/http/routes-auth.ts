import { Hono } from 'hono';
import { z } from 'zod';
import { TwoFactorRequiredError, type ProtonAuth } from '../auth/srp.js';
import type { SessionStore } from '../auth/session-store.js';
import { issueSession, revokeSession, sessionMiddleware, type AuthContext } from './middleware.js';
import { logger } from '../logger.js';
import { DriveClient } from '../drive/client.js';
import { registerLiveSession } from '../auth/live-session.js';
import type { DB } from '../db.js';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

type Env = { Variables: { auth?: AuthContext } };

export function authRoutes(deps: {
  store: SessionStore;
  protonAuth: ProtonAuth;
  db: DB;
  encryptionKey: string;
  appVersion?: string;
}) {
  const r = new Hono<Env>();
  r.use('*', sessionMiddleware(deps.store));

  r.post('/login', async (c) => {
    const parseResult = LoginSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parseResult.success) return c.json({ error: 'invalid_input' }, 400);

    const { email, password, totp } = parseResult.data;
    const remoteUser = c.req.header('Remote-User');
    try {
      const result = await deps.protonAuth.login(email, password, totp);
      deps.store.save(result.session);
      const sid = issueSession(c);

      const driveClient = new DriveClient({
        db: deps.db,
        encryptionKey: deps.encryptionKey,
        appVersion: deps.appVersion ?? 'external-drive-docscanner@0.1.0',
        user: result.decryptedKeys,
        session: result.session,
        protonAuth: deps.protonAuth,
      });

      registerLiveSession({
        sid,
        session: result.session,
        mailboxSecret: result.mailboxSecret,
        decryptedKeys: result.decryptedKeys,
        driveClient,
      });

      logger.info({ email, remoteUser }, 'login succeeded');
      return c.json({ ok: true, email: result.session.email });
    } catch (e) {
      if (e instanceof TwoFactorRequiredError) return c.json({ error: 'totp_required' }, 422);
      const status = (e as { status?: number }).status === 401 ? 401 : 500;
      logger.warn({ email, err: (e as Error).message }, 'login failed');
      return c.json({ error: 'auth_failed', reauth_required: true }, status as 401 | 500);
    }
  });

  r.post('/logout', (c) => {
    deps.store.clear();
    revokeSession(c);
    return c.json({ ok: true });
  });

  r.get('/status', (c) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'not_authenticated' }, 401);
    return c.json({ email: auth.email });
  });

  return r;
}
