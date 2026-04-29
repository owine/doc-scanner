import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { DB } from '../db.js';
import { SessionStore } from '../auth/session-store.js';
import { ProtonAuth } from '../auth/srp.js';
import { ProtonApi } from '../auth/proton-api.js';
import { authRoutes } from './routes-auth.js';
import { driveRoutes } from './routes-drive.js';

export interface AppDeps {
  db: DB;
  encryptionKey: string;
  protonAuth?: ProtonAuth;
  protonApiBaseUrl?: string;
  appVersion?: string;
  secureCookie?: boolean;
  pwaDistPath?: string;
}

export function createApp(deps: AppDeps): Hono {
  const store = new SessionStore(deps.db, deps.encryptionKey);
  const protonAuth = deps.protonAuth ?? new ProtonAuth(
    new ProtonApi(deps.protonApiBaseUrl ?? 'https://mail.proton.me/api', deps.appVersion ?? 'external-drive-docscanner@0.1.0'),
  );

  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.route('/api/auth', authRoutes({ store, protonAuth, db: deps.db, encryptionKey: deps.encryptionKey, appVersion: deps.appVersion, secureCookie: deps.secureCookie }));
  app.route('/api/drive', driveRoutes({ db: deps.db, store }));

  if (deps.pwaDistPath) {
    const root = deps.pwaDistPath;
    app.use('/*', serveStatic({ root }));
    app.get('*', serveStatic({ path: `${root}/index.html` }));
  }

  return app;
}
