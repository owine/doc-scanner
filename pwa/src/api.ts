import { captureRequestFailure } from './observability/sentry.js';

export interface LoginRequest { email: string; password: string; totp?: string }
export interface LoginResponse { ok: true; email: string }
export interface StatusResponse { email: string }

class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
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
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      ...init,
    });
  } catch (error) {
    // The phone may be the only place this failure is visible.
    if (options.reportAs) captureRequestFailure(error, { operation: options.reportAs, path, failure: 'network' });
    throw error;
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const error = new ApiError(body.error ?? 'request_failed', res.status, body.error);
    if (options.reportAs && res.status >= 500) {
      captureRequestFailure(error, { operation: options.reportAs, path, failure: 'http', status: res.status });
    }
    throw error;
  }
  return body as T;
}

export const api = {
  login: (body: LoginRequest) => request<LoginResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  status: () => request<StatusResponse>('/api/auth/status'),
};

export { ApiError };
