import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Sentry from '@sentry/browser';
import type { Event } from '@sentry/browser';
import { buildSentryOptions } from '../../src/observability/sentry.js';
import { request } from '../../src/api.js';

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
