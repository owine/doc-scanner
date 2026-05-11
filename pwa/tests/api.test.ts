import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api, ApiError, PreflightError, CLASSIFY_MAX_PAGE_BYTES, UPLOAD_MAX_PDF_BYTES } from '../src/api.js';

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

describe('api.classify', () => {
  function tinyBlob(bytes = 100): Blob {
    return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
  }

  it('POSTs multipart with page_0..page_N parts on happy path', async () => {
    const fakeSuggestion = {
      suggestedName: 'X', suggestedFolderLinkId: 'f', confidence: 0.8, rationale: 'r',
      pageOcr: [{ text: 'p1', words: [] }, { text: 'p2', words: [] }],
    };
    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ suggestion: fakeSuggestion }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await api.classify([tinyBlob(), tinyBlob()]);
    expect(result).toEqual({ suggestion: fakeSuggestion });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init.method).toBe('POST');
    const fd = init.body as FormData;
    // Note: setup.ts swaps in Node's Blob, which doesn't pass happy-dom's
    // Blob instanceof check. Verify presence by name + size instead.
    expect(fd.get('page_0')).toBeTruthy();
    expect(fd.get('page_1')).toBeTruthy();
    expect(fd.get('page_2')).toBeNull();
  });

  it('returns { suggestion: null } on 413 (server-side body limit) without throwing', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'payload_too_large' }),
      { status: 413, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(api.classify([tinyBlob()])).resolves.toEqual({ suggestion: null });
  });

  it('returns { suggestion: null } on 422 (undecodable image) without throwing', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'undecodable_image', page: 0 }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(api.classify([tinyBlob()])).resolves.toEqual({ suggestion: null });
  });

  it('throws PreflightError before fetch when a page exceeds 2MB', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const oversized = tinyBlob(CLASSIFY_MAX_PAGE_BYTES + 1);
    await expect(api.classify([oversized])).rejects.toBeInstanceOf(PreflightError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws PreflightError before fetch when total payload exceeds 18MB', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // 10 pages × 2MB = 20MB > 18MB total cap.
    const pages = Array.from({ length: 10 }, () => tinyBlob(CLASSIFY_MAX_PAGE_BYTES));
    await expect(api.classify(pages)).rejects.toBeInstanceOf(PreflightError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws PreflightError before fetch when given zero pages', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(api.classify([])).rejects.toBeInstanceOf(PreflightError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('api.upload', () => {
  function pdfBlob(bytes = 1000): Blob {
    return new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
  }

  it('POSTs multipart with pdf + name + folderLinkId + ocrText on happy path', async () => {
    const response = {
      driveNodeUid: 'node-1',
      driveWebUrl: 'https://drive.example/node-1',
      finalName: 'Tax 2026',
    };
    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(response),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await api.upload(pdfBlob(), 'Tax 2026', 'f-tax', 'IRS form text');
    expect(result).toEqual(response);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/upload');
    expect(init.method).toBe('POST');
    const fd = init.body as FormData;
    expect(fd.get('pdf')).toBeTruthy();
    expect(fd.get('name')).toBe('Tax 2026');
    expect(fd.get('folderLinkId')).toBe('f-tax');
    expect(fd.get('ocrText')).toBe('IRS form text');
  });

  it('surfaces collision-suffixed finalName from response', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ driveNodeUid: 'n2', driveWebUrl: 'u2', finalName: 'Tax 2026 (2)' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await api.upload(pdfBlob(), 'Tax 2026', 'f-tax', '');
    expect(result.finalName).toBe('Tax 2026 (2)');
  });

  it('throws ApiError with code reauth_required on 401', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'reauth_required' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(api.upload(pdfBlob(), 'X', 'f', '')).rejects.toMatchObject({
      status: 401, code: 'reauth_required',
    });
  });

  it('throws ApiError with code collision_exhausted on 409', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'collision_exhausted', collision_exhausted: true }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(api.upload(pdfBlob(), 'X', 'f', '')).rejects.toMatchObject({
      status: 409, code: 'collision_exhausted',
    });
  });

  it('throws PreflightError before fetch when pdf exceeds 50MB', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const oversized = pdfBlob(UPLOAD_MAX_PDF_BYTES + 1);
    await expect(api.upload(oversized, 'X', 'f', '')).rejects.toBeInstanceOf(PreflightError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
