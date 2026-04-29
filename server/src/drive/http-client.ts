import type {
  ProtonDriveHTTPClient,
  ProtonDriveHTTPClientJsonRequest,
  ProtonDriveHTTPClientBlobRequest,
} from '@protontech/drive-sdk';

export interface DriveHttpClientConfig {
  baseUrl: string;
  appVersion: string;
  uid: string;
  accessToken: string;
}

/**
 * Adapter implementing the SDK's `ProtonDriveHTTPClient` interface on top of
 * the global `fetch`. Stamps every request with the Proton-required headers
 * (`x-pm-appversion`, `x-pm-uid`, `Authorization: Bearer ...`) and threads a
 * timeout-driven `AbortSignal` so the SDK's `timeoutMs` contract is honoured.
 *
 * The SDK consumes the raw `Response` and performs its own status / parsing
 * handling, so this adapter intentionally does not throw on non-2xx.
 */
export class DriveHttpClient implements ProtonDriveHTTPClient {
  constructor(private readonly config: DriveHttpClientConfig) {}

  async fetchJson(request: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
    const headers = this.commonHeaders(request.headers);
    headers.set('accept', 'application/json');

    let body: RequestInit['body'];
    if (request.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(request.json);
    } else if (request.body !== undefined) {
      body = request.body as RequestInit['body'];
    }

    return this.doFetch(request.url, request.method, headers, body, request.timeoutMs, request.signal);
  }

  async fetchBlob(request: ProtonDriveHTTPClientBlobRequest): Promise<Response> {
    const headers = this.commonHeaders(request.headers);
    const body = request.body as RequestInit['body'] | undefined;
    return this.doFetch(request.url, request.method, headers, body, request.timeoutMs, request.signal);
  }

  private commonHeaders(incoming: Headers): Headers {
    const headers = new Headers(incoming);
    headers.set('authorization', `Bearer ${this.config.accessToken}`);
    headers.set('x-pm-uid', this.config.uid);
    headers.set('x-pm-appversion', this.config.appVersion);
    if (!headers.has('accept-language')) {
      headers.set('accept-language', 'en-US,en;q=0.9');
    }
    if (!headers.has('user-agent')) {
      headers.set('user-agent', `Mozilla/5.0 (compatible; ${this.config.appVersion})`);
    }
    return headers;
  }

  private async doFetch(
    url: string,
    method: string,
    headers: Headers,
    body: RequestInit['body'] | undefined,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort((externalSignal as AbortSignal & { reason?: unknown }).reason);
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort((externalSignal as AbortSignal & { reason?: unknown }).reason);
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);

    try {
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) {
        init.body = body;
      }
      return await fetch(url, init);
    } finally {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  }
}
