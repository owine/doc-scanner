import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { sessionMiddleware, type AuthContext } from './middleware.js';
import type { DB } from '../db.js';
import type { SessionStore } from '../auth/session-store.js';
import { UploadCollisionExhausted } from '../drive/client.js';
import { logger } from '../logger.js';

interface Deps {
  db: DB;
  store: SessionStore;
}

type Env = { Variables: { auth?: AuthContext } };

const NAME_REGEX = /^[a-zA-Z0-9 .,'_-]{1,80}$/;
const MAX_BODY_BYTES = 50 * 1024 * 1024;

// Heuristic for "session expired / re-auth needed". The Proton SDK's exact
// shape for 401-style errors during upload is unverified — same situation
// as the collision detector. Until empirical testing pins it down, we
// treat any error message that mentions "401", "auth", "unauthorized", or
// "token" as a re-auth signal. A future task will tighten this once we've
// observed the real shape.
function looksLikeAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('401') || msg.includes('unauthorized')
    || msg.includes('auth') || msg.includes('token');
}

export function uploadRoutes(deps: Deps): Hono<Env> {
  const app = new Hono<Env>();
  app.use('*', sessionMiddleware(deps.store));

  app.post(
    '/upload',
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
    async (c) => {
      const auth = c.get('auth');
      if (!auth?.liveSession) return c.json({ error: 'not_authenticated' }, 401);

      const form = await c.req.formData();
      const pdf = form.get('pdf');
      const name = form.get('name');
      const folderLinkId = form.get('folderLinkId');
      const ocrText = form.get('ocrText');

      if (!(pdf instanceof Blob)) return c.json({ error: 'missing_pdf' }, 400);
      if (typeof name !== 'string' || !NAME_REGEX.test(name)) {
        return c.json({ error: 'invalid_name' }, 400);
      }
      if (typeof folderLinkId !== 'string' || folderLinkId.length === 0) {
        return c.json({ error: 'missing_folder' }, 400);
      }
      // ocrText is optional (slice 3+ uses it for FTS5 history); accept
      // empty string or missing when present as a non-string field.
      const ocrTextString = typeof ocrText === 'string' ? ocrText : '';

      const folders = auth.liveSession.folderCache.getTree();
      const folder = folders.find((f) => f.linkId === folderLinkId);
      if (!folder) return c.json({ error: 'unknown_folder', folderLinkId }, 400);

      const bytes = new Uint8Array(await pdf.arrayBuffer());
      try {
        const result = await auth.liveSession.driveClient.uploadFile(
          name, bytes, 'application/pdf', { parentFolderUid: folderLinkId },
        );
        deps.db.prepare(
          `INSERT INTO audit_log (event, detail, remote_user) VALUES ('drive_upload', ?, ?)`,
        ).run(
          JSON.stringify({
            scanFinalName: result.finalName,
            requestedName: name,
            folderLinkId,
            folderPath: folder.path,
            driveNodeUid: result.nodeUid,
            ocrTextLength: ocrTextString.length,
          }),
          c.req.header('Remote-User') ?? null,
        );
        // history.recordSave wired in slice 3 — the ocrText field above
        // is captured here so the API contract stays stable across slices.
        logger.info(
          { email: auth.email, finalName: result.finalName, driveNodeUid: result.nodeUid },
          'drive upload succeeded',
        );
        return c.json({
          driveNodeUid: result.nodeUid,
          driveWebUrl: result.driveUrl,
          finalName: result.finalName,
        });
      } catch (err) {
        if (err instanceof UploadCollisionExhausted) {
          logger.warn({ name }, 'drive upload exhausted collision retries');
          return c.json({ error: 'collision_exhausted', collision_exhausted: true }, 409);
        }
        if (looksLikeAuthError(err)) {
          // TODO(slice-2 follow-up): try protonAuth.refresh + rebuild
          // DriveClient with new tokens, retry once. Until then we bounce
          // the user to re-login. PWA scan stays in pending_upload so a
          // later session can drain it.
          logger.warn({ err: (err as Error).message }, 'drive upload auth-style error');
          return c.json({ error: 'reauth_required', reauth_required: true }, 401);
        }
        logger.error({ err: (err as Error).message }, 'drive upload failed');
        return c.json({ error: 'upload_failed', detail: (err as Error).message }, 502);
      }
    },
  );

  return app;
}
