import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { createTestDb } from '../helpers/test-db.js';
import { flushEvents, initRecordingSentry } from '../helpers/sentry-transport.js';

// Sentry must be initialized before createApp, as it is in production
// (instrument.ts is the first import of index.ts).
const { events } = initRecordingSentry();

// Built at runtime, never written literally: the ContextLines integration
// attaches the source lines around each stack frame, and this file is on the
// stack. A literal secret here would "leak" via the test's own source code.
const secret = (name: string): string => ['SECRET', name, Math.random().toString(36).slice(2)].join('-');

describe('Hono error reporting with Sentry initialized', () => {
  beforeEach(() => { events.length = 0; });

  it('reports an unhandled route error once, with the request scrubbed', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const app = createApp({ db, encryptionKey: Buffer.alloc(32, 1).toString('base64') });
      app.post('/api/boom', () => { throw new Error('route exploded'); });

      const query = secret('QUERY');
      const sid = secret('SID');
      const token = secret('AT');
      const body = secret('BODY');

      const res = await app.request(`/api/boom?token=${query}`, {
        method: 'POST',
        headers: { cookie: `docscanner_sid=${sid}`, authorization: `Bearer ${token}` },
        body,
      });
      await flushEvents();

      expect(res.status).toBe(500);
      expect(events).toHaveLength(1);
      expect(events[0]?.exception?.values?.[0]?.value).toBe('route exploded');
      const wire = JSON.stringify(events[0]);
      for (const value of [query, sid, token, body]) {
        expect(wire).not.toContain(value);
      }
    } finally {
      cleanup();
    }
  });

  it('does not report handled 4xx responses', async () => {
    const { db, cleanup } = createTestDb();
    try {
      const app = createApp({ db, encryptionKey: Buffer.alloc(32, 1).toString('base64') });

      const res = await app.request('/api/auth/status');
      await flushEvents();

      expect(res.status).toBe(401);
      expect(events).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
