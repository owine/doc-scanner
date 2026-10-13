import { captureRequestFailure } from './observability/sentry.js';

export interface LoginRequest { email: string; password: string; totp?: string }
export interface LoginResponse { ok: true; email: string }
export interface StatusResponse { email: string }

class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    /** The error response's JSON object, for fields beyond `error` (empty if it wasn't one). */
    public readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface RequestOptions {
  /**
   * Report network failures and 5xx responses to Sentry under this operation
   * name. Opt-in: set it where a failure means lost work (the Drive upload),
   * not on every call, or a phone going offline floods the error tracker.
   */
  reportAs?: string;
}

export async function request<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      ...init,
    });
    // Inside the try: a connection can also drop while the body streams in.
    text = await res.text();
  } catch (error) {
    // The phone may be the only place this failure is visible.
    if (options.reportAs) captureRequestFailure(error, { operation: options.reportAs, path, failure: 'network' });
    throw error;
  }
  if (!res.ok) {
    // An error body may not be JSON: with the server down, the reverse proxy
    // answers with an HTML 502/503. Classify on the status, not the body.
    const body = errorBody(text);
    const code = typeof body.error === 'string' ? body.error : undefined;
    const error = new ApiError(code ?? 'request_failed', res.status, code, body);
    if (options.reportAs && res.status >= 500) {
      captureRequestFailure(error, { operation: options.reportAs, path, failure: 'http', status: res.status });
    }
    throw error;
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function errorBody(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const api = {
  login: (body: LoginRequest) => request<LoginResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  status: () => request<StatusResponse>('/api/auth/status'),
};

export { ApiError };
