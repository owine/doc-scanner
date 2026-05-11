import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ClassifyResult, PastExample } from '../classify/types.js';
import { normaliseForClassify, UndecodableImageError } from '../classify/image.js';
import { sessionMiddleware, type AuthContext } from './middleware.js';
import type { SessionStore } from '../auth/session-store.js';

interface History {
  findRecent(limit: number): PastExample[];
}

interface Deps {
  classify: (input: {
    pages: Uint8Array[];
    folders: { linkId: string; path: string }[];
    examples?: PastExample[];
  }) => Promise<ClassifyResult | null>;
  store: SessionStore;
  /** Slice 3+ wires this; slice 1 omits → empty examples array. */
  history?: History;
}

type Env = { Variables: { auth?: AuthContext } };

const MAX_BODY_BYTES = 20 * 1024 * 1024;

export function classifyRoutes(deps: Deps): Hono<Env> {
  const app = new Hono<Env>();
  app.use('*', sessionMiddleware(deps.store));

  app.post(
    '/classify',
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
    async (c) => {
      const auth = c.get('auth');
      if (!auth?.liveSession) return c.json({ error: 'not_authenticated' }, 401);

      const form = await c.req.formData();

      // Read contiguous page_N parts (page_0, page_1, ...) until a gap.
      // Non-contiguous indices (page_0, page_2 with no page_1) stop the
      // scan at the gap — caller bug surfaces as "fewer pages than sent."
      const pages: Uint8Array[] = [];
      for (let i = 0; ; i++) {
        const part = form.get(`page_${i}`);
        if (!(part instanceof Blob)) break;
        const raw = new Uint8Array(await part.arrayBuffer());
        try {
          pages.push(await normaliseForClassify(raw));
        } catch (err) {
          if (err instanceof UndecodableImageError) {
            return c.json({ error: 'undecodable_image', page: i }, 422);
          }
          throw err;
        }
      }
      if (pages.length === 0) return c.json({ error: 'no_pages' }, 400);

      const folders = auth.liveSession.folderCache.getTree();
      const examples = deps.history?.findRecent(3) ?? [];
      const suggestion = await deps.classify({ pages, folders, examples });
      return c.json({ suggestion });
    },
  );

  return app;
}
