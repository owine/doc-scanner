import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api, ApiError } from '../src/api.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('api.getFolders', () => {
  it('GETs /api/drive/folders without query when refresh=false', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ folders: [{ linkId: 'root', path: '/' }, { linkId: 'f1', path: '/Tax' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await api.getFolders();

    expect(result).toEqual({ folders: [{ linkId: 'root', path: '/' }, { linkId: 'f1', path: '/Tax' }] });
    expect(fetchSpy).toHaveBeenCalledWith('/api/drive/folders', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('appends ?refresh=1 when refresh=true', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ folders: [{ linkId: 'root', path: '/' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchSpy);

    await api.getFolders(true);

    expect(fetchSpy).toHaveBeenCalledWith('/api/drive/folders?refresh=1', expect.anything());
  });

  it('throws ApiError on 401', async () => {
    const fetchSpy = vi.fn().mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({ error: 'not_authenticated' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(api.getFolders()).rejects.toBeInstanceOf(ApiError);
    await expect(api.getFolders()).rejects.toMatchObject({ status: 401, code: 'not_authenticated' });
  });
});
