import { Hono } from 'hono';
import type { DB } from '../db.js';
import { SessionStore } from '../auth/session-store.js';
import { ProtonAuth } from '../auth/srp.js';
import { ProtonApi } from '../auth/proton-api.js';
import { authRoutes } from './routes-auth.js';

export interface AppDeps {
  db: DB;
  encryptionKey: string;
  protonAuth?: ProtonAuth;
  protonApiBaseUrl?: string;
  appVersion?: string;
}

export function createApp(deps: AppDeps): Hono {
  const store = new SessionStore(deps.db, deps.encryptionKey);
  const protonAuth = deps.protonAuth ?? new ProtonAuth(
    new ProtonApi(deps.protonApiBaseUrl ?? 'https://mail.proton.me/api', deps.appVersion ?? 'external-drive-docscanner@0.1.0'),
  );

  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.route('/api/auth', authRoutes({ store, protonAuth, db: deps.db, encryptionKey: deps.encryptionKey, appVersion: deps.appVersion }));
  return app;
}
