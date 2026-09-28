import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { sessionMiddleware, type AuthContext } from './middleware.js';
import type { DB } from '../db.js';
import type { SessionStore } from '../auth/session-store.js';
import { ServerError } from '@protontech/drive-sdk';
import { logger } from '../logger.js';

interface History {
  recordSave(rec: {
    ocrText: string;
    finalName: string;
    folderLinkId: string;
    folderPath: string;
    driveNodeUid: string;
  }): void;
}

interface Deps {
  db: DB;
  store: SessionStore;
  /** Slice 3+ injects ClassificationHistory; absent in earlier slices. */
  history?: History;
}

type Env = { Variables: { auth?: AuthContext } };

const NAME_REGEX = /^[a-zA-Z0-9 .,'_-]{1,80}$/;
const MAX_BODY_BYTES = 50 * 1024 * 1024;

// DriveHttpClient already refreshes the access token on a 401 and replays the
// request, so a 401 that still reaches the SDK means the refresh token is dead
// too. The SDK's apiErrorFactory turns it into a ServerError one of two ways:
// with a JSON body, an APICodeError whose `code` is the body's Code (401 for an
// invalid token); without one, an APIHTTPError whose `statusCode` is 401.
// The body shape is taken from the SDK source, not yet observed on a live
// expired session.
function isAuthExpired(err: unknown): boolean {
  return err instanceof ServerError && (err.statusCode === 401 || err.code === 401);
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
            scanFinalName: result.name,
            requestedName: name,
            folderLinkId,
            folderPath: folder.path,
            driveNodeUid: result.nodeUid,
            ocrTextLength: ocrTextString.length,
          }),
          c.req.header('Remote-User') ?? null,
        );
        // Slice 3: best-effort history record so future classify calls can
        // include this save as an in-context example. recordSave is itself
        // best-effort (logs on failure, doesn't throw) — the upload's user-
        // visible success is not gated on history.
        deps.history?.recordSave({
          ocrText: ocrTextString,
          finalName: result.name,
          folderLinkId,
          folderPath: folder.path,
          driveNodeUid: result.nodeUid,
        });
        logger.info(
          { email: auth.email, finalName: result.name, driveNodeUid: result.nodeUid },
          'drive upload succeeded',
        );
        return c.json({
          driveNodeUid: result.nodeUid,
          driveWebUrl: result.driveUrl,
          finalName: result.name,
        });
      } catch (err) {
        if (isAuthExpired(err)) {
          // The PWA scan stays in pending_upload so the outbox drains it after
          // the user logs in again.
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
