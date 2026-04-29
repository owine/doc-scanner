import { Hono } from 'hono';
import { z } from 'zod';
import { sessionMiddleware, type AuthContext } from './middleware.js';
import { logger } from '../logger.js';
import type { DB } from '../db.js';
import type { SessionStore } from '../auth/session-store.js';

const TestUploadSchema = z.object({ name: z.string().optional() });

type Env = { Variables: { auth?: AuthContext } };

export function driveRoutes(deps: { db: DB; store: SessionStore }) {
  const r = new Hono<Env>();
  r.use('*', sessionMiddleware(deps.store));

  r.post('/test-upload', async (c) => {
    const auth = c.get('auth');
    if (!auth?.liveSession) return c.json({ error: 'not_authenticated' }, 401);

    const body = TestUploadSchema.safeParse(await c.req.json().catch(() => ({})));
    const name = body.success && body.data.name
      ? body.data.name
      : `doc-scanner-test-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;

    const payload = `doc-scanner test ${new Date().toISOString()}`;
    const bytes = new TextEncoder().encode(payload);

    try {
      const { nodeUid, driveUrl } = await auth.liveSession.driveClient.uploadFile(name, bytes, 'text/plain');
      deps.db.prepare(`
        INSERT INTO audit_log (event, detail, remote_user)
        VALUES ('drive_test_upload', ?, ?)
      `).run(JSON.stringify({ filename: name, nodeUid, driveUrl }), c.req.header('Remote-User') ?? null);
      logger.info({ email: auth.email, nodeUid }, 'drive test upload succeeded');
      return c.json({ ok: true, nodeUid, driveUrl, filename: name });
    } catch (e) {
      logger.warn({ email: auth.email, err: (e as Error).message }, 'drive test upload failed');
      return c.json({ error: 'upload_failed', detail: (e as Error).message }, 500);
    }
  });

  return r;
}
