import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Sentry from '@sentry/browser';
import type { Event } from '@sentry/browser';
import { buildSentryOptions } from '../../src/observability/sentry.js';
import { api, request } from '../../src/api.js';

// Real browser SDK, app options (scrubber included), recording transport.
const events: Event[] = [];
const options = buildSentryOptions({ VITE_SENTRY_DSN: 'https://public@glitchtip.example.test/2' })!;
Sentry.init({
  ...options,
  transport: () => ({
    send: async (envelope) => {
      for (const [header, payload] of envelope[1]) if (header.type === 'event') events.push(payload as Event);
      return {};
    },
    flush: async () => true,
  }),
});

const marker = `PAGE-${Math.random().toString(36).slice(2)}`;

function tagsOf(index: number): Record<string, unknown> | undefined {
  return events[index]?.tags as Record<string, unknown> | undefined;
}

describe('API request failure reporting', () => {
  beforeEach(() => { events.length = 0; });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reports a network failure on a reported request, without the body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));

    await expect(request('/api/upload', { method: 'POST', body: marker }, { reportAs: 'upload' })).rejects.toThrow('Load failed');
    await Sentry.flush(1000);

    expect(events).toHaveLength(1);
    expect(tagsOf(0)).toMatchObject({ 'api.operation': 'upload', 'api.failure': 'network', 'network.online': 'true' });
    expect(JSON.stringify(events[0])).not.toContain(marker);
  });

  it('reports a 5xx response on a reported request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"upload_failed"}', { status: 502 })));

    await expect(request('/api/upload', { method: 'POST', body: marker }, { reportAs: 'upload' })).rejects.toThrow();
    await Sentry.flush(1000);

    expect(events).toHaveLength(1);
    expect(tagsOf(0)).toMatchObject({ 'api.operation': 'upload', 'api.failure': 'http', 'api.status': '502' });
  });

  it('api.upload opts in, and leaves the multipart content-type to the browser', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{"error":"upload_failed"}', { status: 502 }));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(api.upload(new Blob([marker], { type: 'application/pdf' }), 'Receipt', 'f-tax', '')).rejects.toThrow();
    await Sentry.flush(1000);

    expect(events).toHaveLength(1);
    expect(tagsOf(0)).toMatchObject({ 'api.operation': 'upload', 'api.path': '/api/upload', 'api.status': '502' });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it('reports a 5xx with a non-JSON body (a proxy error page when the server is down)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 })));

    await expect(request('/api/upload', { method: 'POST' }, { reportAs: 'upload' })).rejects.toThrow();
    await Sentry.flush(1000);

    expect(events).toHaveLength(1);
    expect(tagsOf(0)).toMatchObject({ 'api.operation': 'upload', 'api.failure': 'http', 'api.status': '502' });
  });

  it('reports a connection that drops while the response body is read as a network failure', async () => {
    const broken = new ReadableStream({ start(controller) { controller.error(new TypeError('network connection was lost')); } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(broken, { status: 200 })));

    await expect(request('/api/upload', { method: 'POST' }, { reportAs: 'upload' })).rejects.toThrow();
    await Sentry.flush(1000);

    expect(events).toHaveLength(1);
    expect(tagsOf(0)).toMatchObject({ 'api.operation': 'upload', 'api.failure': 'network' });
  });

  it('does not report 4xx responses, which the UI handles', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"not_authenticated"}', { status: 401 })));

    await expect(request('/api/upload', { method: 'POST' }, { reportAs: 'upload' })).rejects.toThrow();
    await Sentry.flush(1000);

    expect(events).toHaveLength(0);
  });

  it('does not report requests that did not opt in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));

    await expect(request('/api/auth/status')).rejects.toThrow();
    await Sentry.flush(1000);

    expect(events).toHaveLength(0);
  });
});
