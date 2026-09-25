import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import * as Sentry from '@sentry/hono/node';
import { createApp } from '../../src/http/server.js';
import { createTestDb } from '../helpers/test-db.js';
import { flushEvents, initRecordingSentry } from '../helpers/sentry-transport.js';

// What the SDK does on its own once initialized, observed through a REAL http
// server: `app.request` bypasses @sentry/node's http integration, so tests
// using it cannot see incoming-body capture or outgoing header injection.

// The Dockerfile's default GIT_SHA. Must not become the client's release,
// including via the SDK's own fallback to process.env.
process.env.GIT_SHA = 'dev';

const { events } = initRecordingSentry();

// Every event as it looks BEFORE beforeSend: proves what the SDK holds, not
// just what the scrubber lets out.
const preScrub: Sentry.Event[] = [];
Sentry.addEventProcessor((event) => {
  preScrub.push(structuredClone(event));
  return event;
});

const secret = (name: string): string => ['SECRET', name, Math.random().toString(36).slice(2)].join('-');

async function listen(server: Server | ServerType): Promise<number> {
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return (server.address() as AddressInfo).port;
}

describe('SDK behaviour with a DSN', () => {
  let cleanup: () => void;
  let servers: Array<Server | ServerType>;

  beforeEach(() => {
    events.length = 0;
    preScrub.length = 0;
    servers = [];
    cleanup = () => {};
  });

  afterEach(async () => {
    cleanup();
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  });

  function startApp(extra: (app: ReturnType<typeof createApp>) => void): Promise<number> {
    const test = createTestDb();
    cleanup = test.cleanup;
    const app = createApp({ db: test.db, encryptionKey: Buffer.alloc(32, 1).toString('base64') });
    extra(app);
    const server = serve({ fetch: app.fetch, port: 0 });
    servers.push(server);
    return listen(server);
  }

  it('does not hold the incoming request body (the login password) on the event', async () => {
    const body = secret('PASSWORD');
    const port = await startApp((app) => {
      app.post('/api/boom', async (c) => {
        await c.req.text();
        throw new Error('route exploded');
      });
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/boom`, { method: 'POST', body: JSON.stringify({ password: body }) });
    await flushEvents();

    expect(res.status).toBe(500);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(preScrub)).not.toContain(body);
  });

  it('adds no sentry-trace / baggage headers to outgoing requests (Proton, Anthropic)', async () => {
    const received: IncomingHttpHeaders[] = [];
    const upstream = createServer((req, res) => {
      received.push(req.headers);
      res.end('ok');
    });
    servers.push(upstream);
    upstream.listen(0);
    const upstreamPort = await listen(upstream);
    const port = await startApp((app) => {
      app.get('/api/proxy', async (c) => c.text(await (await fetch(`http://127.0.0.1:${upstreamPort}/`)).text()));
    });

    await fetch(`http://127.0.0.1:${port}/api/proxy`);

    expect(received).toHaveLength(1);
    expect(received[0]).not.toHaveProperty('sentry-trace');
    expect(received[0]).not.toHaveProperty('baggage');
  });

  it('reports a thrown error carrying a 4xx status (e.g. a ProtonApiError 429) that became a 500', async () => {
    const port = await startApp((app) => {
      app.get('/api/rate-limited', () => { throw Object.assign(new Error('Too many requests'), { status: 429 }); });
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/rate-limited`);
    await flushEvents();

    expect(res.status).toBe(500);
    expect(events).toHaveLength(1);
  });

  it('does not use the Dockerfile "dev" placeholder as the release', () => {
    expect(Sentry.getClient()?.getOptions().release).not.toBe('dev');
  });
});
