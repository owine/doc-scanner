import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DriveHttpClient } from '../../src/drive/http-client.js';

describe('DriveHttpClient', () => {
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function makeClient() {
    return new DriveHttpClient({
      baseUrl: 'https://drive-api.example.test',
      appVersion: 'external-drive-docscanner@0.1.0',
      uid: 'uid-x',
      accessToken: 'at-x',
    });
  }

  describe('fetchJson', () => {
    it('sends Authorization, x-pm-uid, x-pm-appversion headers and accept JSON', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
      const client = makeClient();

      const headers = new Headers();
      await client.fetchJson({
        url: 'https://drive-api.example.test/some/endpoint',
        method: 'GET',
        headers,
        timeoutMs: 30000,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://drive-api.example.test/some/endpoint');
      const sentHeaders = (init as RequestInit).headers as Headers;
      expect(sentHeaders.get('authorization')).toBe('Bearer at-x');
      expect(sentHeaders.get('x-pm-uid')).toBe('uid-x');
      expect(sentHeaders.get('x-pm-appversion')).toBe('external-drive-docscanner@0.1.0');
      expect(sentHeaders.get('accept')).toBe('application/json');
    });

    it('serialises a json body and sets content-type', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const client = makeClient();
      await client.fetchJson({
        url: 'https://drive-api.example.test/x',
        method: 'POST',
        headers: new Headers(),
        timeoutMs: 30000,
        json: { Foo: 'bar' },
      });
      const [, init] = mockFetch.mock.calls[0]!;
      expect((init as RequestInit).body).toBe(JSON.stringify({ Foo: 'bar' }));
      const sentHeaders = (init as RequestInit).headers as Headers;
      expect(sentHeaders.get('content-type')).toBe('application/json');
    });

    it('returns the raw Response (does not throw on non-2xx)', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{"Error":"Forbidden","Code":403}', { status: 403 }));
      const client = makeClient();
      const res = await client.fetchJson({
        url: 'https://drive-api.example.test/x',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Forbidden');
    });

    it('preserves caller-provided headers', async () => {
      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const client = makeClient();
      const headers = new Headers();
      headers.set('x-custom', 'value');
      await client.fetchJson({
        url: 'https://drive-api.example.test/x',
        method: 'GET',
        headers,
        timeoutMs: 30000,
      });
      const [, init] = mockFetch.mock.calls[0]!;
      const sentHeaders = (init as RequestInit).headers as Headers;
      expect(sentHeaders.get('x-custom')).toBe('value');
    });

    it('aborts after timeoutMs and rejects', async () => {
      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      });
      const client = makeClient();
      await expect(
        client.fetchJson({
          url: 'https://drive-api.example.test/x',
          method: 'GET',
          headers: new Headers(),
          timeoutMs: 10,
        }),
      ).rejects.toThrow();
    });

    it('honours an externally provided AbortSignal', async () => {
      const ac = new AbortController();
      mockFetch.mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      });
      const client = makeClient();
      const p = client.fetchJson({
        url: 'https://drive-api.example.test/x',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 30000,
        signal: ac.signal,
      });
      ac.abort();
      await expect(p).rejects.toThrow();
    });
  });

  describe('fetchBlob', () => {
    it('forwards body and Proton headers', async () => {
      mockFetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
      const client = makeClient();
      const body = new Uint8Array([9, 9, 9]);
      const res = await client.fetchBlob({
        url: 'https://drive-api.example.test/blob',
        method: 'POST',
        headers: new Headers(),
        timeoutMs: 60000,
        body,
      });
      expect(res.status).toBe(200);
      const [, init] = mockFetch.mock.calls[0]!;
      expect((init as RequestInit).body).toBe(body);
      const sentHeaders = (init as RequestInit).headers as Headers;
      expect(sentHeaders.get('authorization')).toBe('Bearer at-x');
      expect(sentHeaders.get('x-pm-uid')).toBe('uid-x');
      expect(sentHeaders.get('x-pm-appversion')).toBe('external-drive-docscanner@0.1.0');
    });

    it('returns the raw Response on non-2xx', async () => {
      mockFetch.mockResolvedValueOnce(new Response('boom', { status: 500 }));
      const client = makeClient();
      const res = await client.fetchBlob({
        url: 'https://drive-api.example.test/blob',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 60000,
      });
      expect(res.status).toBe(500);
    });
  });
});
