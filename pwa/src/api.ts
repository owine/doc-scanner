export interface LoginRequest { email: string; password: string; totp?: string }
export interface LoginResponse { ok: true; email: string }
export interface StatusResponse { email: string }
export interface FolderEntry { linkId: string; path: string }
export interface FoldersResponse { folders: FolderEntry[] }

export interface ClassifyWord { text: string; x: number; y: number; w: number; h: number }
export interface PageOcrResponse { text: string; words: ClassifyWord[] }
export interface ClassifySuggestion {
  suggestedName: string;
  suggestedFolderLinkId: string;
  confidence: number;
  rationale: string;
  pageOcr: PageOcrResponse[];
}
export interface ClassifyResponse { suggestion: ClassifySuggestion | null }

export const CLASSIFY_MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const CLASSIFY_MAX_TOTAL_BYTES = 18 * 1024 * 1024;

export class PreflightError extends Error {}

class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(body.error ?? 'request_failed', res.status, body.error);
  return body as T;
}

/**
 * Multipart upload of N page images to /api/classify. Pre-flight rejects
 * blobs that would exceed server limits (per-page 2MB, total 18MB) before
 * the network call so the user sees a fast error rather than a 413.
 *
 * Maps server 413/422 to `{ suggestion: null }` so the UI degrades to an
 * empty ConfirmCard (user can fill in manually) instead of a hard error
 * — same semantics as Anthropic timeouts in classify/haiku.ts.
 */
async function classifyMultipart(pages: Blob[]): Promise<ClassifyResponse> {
  if (pages.length === 0) throw new PreflightError('no pages to classify');
  let total = 0;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!;
    if (p.size > CLASSIFY_MAX_PAGE_BYTES) {
      throw new PreflightError(`page ${i} too large (${p.size} > ${CLASSIFY_MAX_PAGE_BYTES})`);
    }
    total += p.size;
  }
  if (total > CLASSIFY_MAX_TOTAL_BYTES) {
    throw new PreflightError(`total payload too large (${total} > ${CLASSIFY_MAX_TOTAL_BYTES})`);
  }
  const fd = new FormData();
  pages.forEach((p, i) => fd.set(`page_${i}`, p, `page_${i}.jpg`));
  const res = await fetch('/api/classify', { method: 'POST', body: fd, credentials: 'same-origin' });
  if (!res.ok) {
    if (res.status === 413 || res.status === 422) return { suggestion: null };
    const text = await res.text().catch(() => '');
    const body = text ? JSON.parse(text) : {};
    throw new ApiError(body.error ?? 'request_failed', res.status, body.error);
  }
  return res.json() as Promise<ClassifyResponse>;
}

export const api = {
  login: (body: LoginRequest) => request<LoginResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  status: () => request<StatusResponse>('/api/auth/status'),
  getFolders: (refresh = false) =>
    request<FoldersResponse>(refresh ? '/api/drive/folders?refresh=1' : '/api/drive/folders'),
  classify: (pages: Blob[]) => classifyMultipart(pages),
};

export { ApiError };
