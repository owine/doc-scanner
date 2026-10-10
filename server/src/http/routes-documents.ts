import { createHash } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';
import type { SessionStore } from '../auth/session-store.js';
import { sanitiseName } from '../analyze/resolve.js';
import type { Pipeline } from '../documents/pipeline.js';
import type { Decision, DocumentRow, DocumentState } from '../documents/types.js';
import { toView } from '../documents/view.js';
import { isUnderAny } from '../drive/folder-tree.js';
import { logger } from '../logger.js';
import { errorName } from '../observability/error-name.js';
import { captureDriveFailure } from '../observability/report.js';
import { sessionMiddleware, type AuthContext } from './middleware.js';

type Env = { Variables: { auth?: AuthContext } };

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Email arrives with its own credential (email-in spec), never a browser cookie. */
const COOKIE_SOURCES = ['picker', 'scanner', 'share'] as const;

const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  if (!c.get('auth')) return c.json({ error: 'not_authenticated' }, 401);
  await next();
};

/** A sub-app whose every route needs a login. Mount at its own prefix (see the routing trap). */
function guarded(store: SessionStore): Hono<Env> {
  const r = new Hono<Env>();
  r.use('*', sessionMiddleware(store), requireAuth);
  return r;
}

const ApproveSchema = z
  .object({
    name: z.string().optional(),
    folder: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('existing'), linkId: z.string().min(1) }),
        z.object({ kind: z.literal('new'), parentLinkId: z.string().min(1), name: z.string().min(1) }),
      ])
      .optional(),
  })
  .strict();

function sameFolder(a: Decision['folder'] | null | undefined, b: Decision['folder'] | null | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === 'existing' ? a.linkId === (b as typeof a).linkId : a.parentLinkId === (b as typeof a).parentLinkId && a.name === (b as typeof a).name;
}

type FolderChoice = { kind: 'existing'; linkId: string } | { kind: 'new'; parentLinkId: string; name: string };

/** `want` with its path(s) taken from the current folder tree, or null if its folder is gone. */
function currentFolder(want: FolderChoice, pathOf: ReadonlyMap<string, string>): Decision['folder'] | null {
  if (want.kind === 'existing') {
    const path = pathOf.get(want.linkId);
    return path ? { kind: 'existing', linkId: want.linkId, path } : null;
  }
  const parentPath = pathOf.get(want.parentLinkId);
  const name = sanitiseName(want.name, '');
  return parentPath && name ? { kind: 'new', parentLinkId: want.parentLinkId, parentPath, name } : null;
}

/** Where a failed document picks up on retry: as late as what it already has allows. */
function restartState(d: DocumentRow): DocumentState {
  return d.decision ? 'filing' : d.analysis ? 'ready' : 'received';
}

export function documentRoutes(deps: { store: SessionStore; pipeline: Pipeline }) {
  const { repo, inbox, folderCache, worker } = deps.pipeline;
  const r = guarded(deps.store);

  r.post(
    '/',
    bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
    async (c) => {
      const form = await c.req.formData().catch(() => null);
      const file = form?.get('file');
      const source = form?.get('source');
      if (!(file instanceof File)) return c.json({ error: 'missing_file' }, 400);
      if (typeof source !== 'string' || !(COOKIE_SOURCES as readonly string[]).includes(source)) {
        return c.json({ error: 'invalid_source' }, 400);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length === 0) return c.json({ error: 'empty_file' }, 400);
      const sha256 = createHash('sha256').update(bytes).digest('hex');

      const existing = repo.findActiveBySha256(sha256);
      if (existing) {
        if (existing.state === 'failed') {
          repo.transition(existing.id, 'failed', restartState(existing), { attempts: 0, error: null, nextAttemptAt: new Date() });
          void worker.wake();
        }
        return c.json({ id: existing.id, duplicate: true }, 200);
      }

      const originalName = form!.get('originalName');
      const sourceContext = form!.get('sourceContext');
      const doc = repo.insert({
        source: source as (typeof COOKIE_SOURCES)[number],
        originalName: typeof originalName === 'string' && originalName ? originalName : file.name || null,
        mime: file.type || 'application/octet-stream',
        size: bytes.length,
        sha256,
        sourceContext: typeof sourceContext === 'string' && sourceContext ? sourceContext : null,
      });
      try {
        inbox.put(doc.id, 'original', bytes);
      } catch (err) {
        repo.delete(doc.id);
        throw err;
      }
      void worker.wake();
      return c.json({ id: doc.id }, 202);
    },
  );

  r.get('/', (c) => {
    const since = Number(c.req.query('since') ?? '0');
    if (!Number.isInteger(since) || since < 0) return c.json({ error: 'invalid_cursor' }, 400);
    const docs = repo.listChangedSince(since);
    return c.json({ documents: docs.map(toView), cursor: docs.length ? docs[docs.length - 1]!.seq : since });
  });

  r.get('/:id', (c) => {
    const doc = repo.get(c.req.param('id'));
    return doc ? c.json(toView(doc)) : c.json({ error: 'not_found' }, 404);
  });

  r.post('/:id/approve', async (c) => {
    const doc = repo.get(c.req.param('id'));
    if (!doc) return c.json({ error: 'not_found' }, 404);
    if (doc.state !== 'needs_review') return c.json({ error: 'not_in_review' }, 409);
    // Only an empty body means "as suggested": a truncated one must not file
    // anything, because an upload can't be taken back.
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim()) {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json({ error: 'invalid_input' }, 400);
      }
    }
    const body = ApproveSchema.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_input' }, 400);
    const cache = folderCache.load();
    if (!cache) return c.json({ error: 'folders_not_loaded' }, 503);
    const pathOf = new Map(cache.tree.map((f) => [f.linkId, f.path]));

    const name = sanitiseName(body.data.name ?? doc.analysis?.name ?? '', '');
    if (!name) return c.json({ error: 'name_required' }, 400);

    // The user's choice, else the suggestion; either way checked against the
    // current tree, since a suggested folder may have moved or gone since.
    const want = body.data.folder ?? doc.analysis?.folder;
    if (!want) return c.json({ error: 'folder_required' }, 400);
    const folder = currentFolder(want, pathOf);
    if (!folder) return c.json({ error: 'unknown_folder' }, 400);

    const userEdited = name !== doc.analysis?.name || !sameFolder(folder, doc.analysis?.folder);
    const moved = repo.transition(doc.id, 'needs_review', 'filing', {
      decision: { name, folder },
      userEdited,
      autoFiled: false,
      attempts: 0,
      error: null,
      nextAttemptAt: new Date(),
    });
    if (!moved) return c.json({ error: 'conflict' }, 409);
    void worker.wake();
    return c.json(toView(repo.get(doc.id)!));
  });

  r.post('/:id/discard', (c) => {
    const result = repo.requestDiscard(c.req.param('id'));
    if (result === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (result === 'not_allowed') return c.json({ error: 'not_allowed' }, 409);
    // A working document's discard is applied by the worker; wake it so that happens now.
    if (result === 'requested') void worker.wake();
    return c.json({ result });
  });

  r.post('/:id/restore', (c) => {
    const doc = repo.get(c.req.param('id'));
    if (!doc || doc.state !== 'discarded') return c.json({ error: 'not_discarded' }, 409);
    const to: DocumentState = doc.analysis ? 'needs_review' : 'received';
    repo.transition(doc.id, 'discarded', to, { discardedAt: null, reviewReason: 'restored after discard', nextAttemptAt: new Date() });
    void worker.wake();
    return c.json(toView(repo.get(doc.id)!));
  });

  r.post('/:id/retry', (c) => {
    const doc = repo.get(c.req.param('id'));
    if (!doc || doc.state !== 'failed') return c.json({ error: 'not_failed' }, 409);
    repo.transition(doc.id, 'failed', restartState(doc), { attempts: 0, error: null, nextAttemptAt: new Date() });
    void worker.wake();
    return c.json(toView(repo.get(doc.id)!));
  });

  return r;
}

export function folderRoutes(deps: { store: SessionStore; pipeline: Pipeline }) {
  const r = guarded(deps.store);
  // On-demand re-walk (spec §4), e.g. after reorganising folders in Drive.
  r.post('/refresh', async (c) => {
    if (!c.get('auth')?.liveSession) return c.json({ error: 'not_logged_in' }, 409);
    try {
      await deps.pipeline.worker.refreshFolderCache();
    } catch (err) {
      // The type only: a walk error's message can quote folder paths. Still
      // reported, as it was when it escaped to the Sentry middleware.
      logger.error({ errName: errorName(err) }, 'folder refresh failed');
      captureDriveFailure(err, 'folder-lookup');
      return c.json({ error: 'refresh_failed' }, 502);
    }
    return c.json({ ok: true });
  });
  r.get('/', (c) => {
    const cache = deps.pipeline.folderCache.load();
    if (!cache) return c.json({ error: 'folders_not_loaded' }, 503);
    const { excludePaths } = deps.pipeline.settings.get();
    return c.json({
      walkedAt: cache.walkedAt.toISOString(),
      folders: cache.tree.filter((f) => !isUnderAny(f.path, excludePaths)).map((f) => ({ linkId: f.linkId, path: f.path })),
    });
  });
  return r;
}

export function settingsRoutes(deps: { store: SessionStore; pipeline: Pipeline }) {
  const r = guarded(deps.store);
  r.get('/', (c) => c.json(deps.pipeline.settings.get()));
  r.put('/', async (c) => {
    try {
      return c.json(deps.pipeline.settings.update(await c.req.json()));
    } catch (err) {
      if (err instanceof ZodError || err instanceof SyntaxError) return c.json({ error: 'invalid_input' }, 400);
      throw err;
    }
  });
  return r;
}
