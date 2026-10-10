import { describe, it, expect, vi, afterEach } from 'vitest';
import { documentsApi } from '../../src/documents/api.js';
import { ApiError } from '../../src/api.js';

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(body: unknown, status = 200) {
  // A fresh Response per call: a body can only be read once.
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('documentsApi', () => {
  it('lists changes since a cursor', async () => {
    const fetch = stubFetch({ documents: [], cursor: 7 });
    await expect(documentsApi.list(3)).resolves.toEqual({ documents: [], cursor: 7 });
    expect(fetch.mock.calls[0]![0]).toBe('/api/documents?since=3');
  });

  it('approves with a JSON body, escaping the id', async () => {
    const fetch = stubFetch({ id: 'a/b' });
    await documentsApi.approve('a/b', { name: 'Northwind Energy Bill' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/documents/a%2Fb/approve');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'Northwind Energy Bill' });
  });

  it('surfaces the server error code', async () => {
    stubFetch({ error: 'unknown_folder' }, 400);
    await expect(documentsApi.approve('x', {})).rejects.toMatchObject({ status: 400, code: 'unknown_folder' });
    await expect(documentsApi.approve('x', {})).rejects.toBeInstanceOf(ApiError);
  });

  it('saves a settings patch with PUT', async () => {
    const fetch = stubFetch({ autoFileEnabled: true });
    await documentsApi.saveSettings({ autoFileEnabled: true });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('/api/settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ autoFileEnabled: true });
  });
});
