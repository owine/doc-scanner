import type {
  ProtonDriveHTTPClient,
  ProtonDriveHTTPClientJsonRequest,
  ProtonDriveHTTPClientBlobRequest,
} from '@protontech/drive-sdk';

/** The subset of a Proton session the transport needs to authenticate. */
export interface DriveHttpSession {
  uid: string;
  accessToken: string;
}

export interface DriveHttpClientConfig {
  /** Proton appversion string (e.g. "external-drive-docscanner@0.1.0"). */
  appVersion: string;
  /**
   * Reads the *current* session. Deliberately a getter rather than a snapshot:
   * access tokens are refreshed mid-session, and a captured token would make
   * every request after expiry fail with 401.
   */
  getSession: () => DriveHttpSession;
  /**
   * Refreshes the session after a 401. Omit to disable refresh-and-retry (the
   * 401 is then returned to the SDK unchanged).
   */
  refreshSession?: () => Promise<DriveHttpSession>;
}

/**
 * Adapter implementing the SDK's `ProtonDriveHTTPClient` interface on top of
 * the global `fetch`. Stamps every request with the Proton-required headers
 * (`x-pm-appversion`, `x-pm-uid`, `Authorization: Bearer ...`) and threads a
 * timeout-driven `AbortSignal` so the SDK's `timeoutMs` contract is honoured.
 *
 * The SDK consumes the raw `Response` and performs its own status / parsing
 * handling, so this adapter intentionally does not throw on non-2xx. The one
 * status it acts on is 401: it refreshes the access token and replays the
 * request once. Replay is safe because the SDK only ever sends
 * `XMLHttpRequestBodyInit` bodies (string / BufferSource / Blob / FormData),
 * all of which are re-readable — unlike a streaming body.
 *
 * Known gap: `ProtonDriveHTTPClientBlobRequest.onProgress` is ignored. `fetch`
 * cannot report upload progress; supporting it would mean dropping to XHR or
 * wrapping the body in a counting stream. Nothing in the current upload path
 * consumes progress.
 */
export class DriveHttpClient implements ProtonDriveHTTPClient {
  /** Shared across concurrent 401s so a burst triggers one refresh, not N. */
  private refreshInFlight?: Promise<DriveHttpSession>;

  constructor(private readonly config: DriveHttpClientConfig) {}

  async fetchJson(request: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
    let body: RequestInit['body'];
    let contentType: string | undefined;
    if (request.json !== undefined) {
      contentType = 'application/json';
      body = JSON.stringify(request.json);
    } else if (request.body !== undefined) {
      body = request.body as RequestInit['body'];
    }

    return this.send(request, body, { accept: 'application/json', contentType });
  }

  async fetchBlob(request: ProtonDriveHTTPClientBlobRequest): Promise<Response> {
    return this.send(request, request.body as RequestInit['body'] | undefined, {});
  }

  private async send(
    request: {
      url: string;
      method: string;
      headers: Headers;
      timeoutMs: number;
      signal?: AbortSignal;
    },
    body: RequestInit['body'] | undefined,
    extra: { accept?: string; contentType?: string },
  ): Promise<Response> {
    const build = (): Headers => {
      const headers = this.commonHeaders(request.headers);
      if (extra.accept) headers.set('accept', extra.accept);
      if (extra.contentType) headers.set('content-type', extra.contentType);
      return headers;
    };

    const response = await this.doFetch(
      request.url,
      request.method,
      build(),
      body,
      request.timeoutMs,
      request.signal,
    );

    if (response.status !== 401 || !this.config.refreshSession) return response;

    // Drain the failed response so the connection is not held open, then
    // refresh once and replay with the new token.
    void response.body?.cancel();
    try {
      await this.refresh();
    } catch {
      // Refresh failed (expired or revoked refresh token). Surface the
      // original 401 so the SDK's error handling — and the caller's re-auth
      // prompt — behave exactly as they would without refresh support.
      return response;
    }

    return this.doFetch(
      request.url,
      request.method,
      build(),
      body,
      request.timeoutMs,
      request.signal,
    );
  }

  private async refresh(): Promise<DriveHttpSession> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.config.refreshSession!().finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  private commonHeaders(incoming: Headers): Headers {
    const session = this.config.getSession();
    const headers = new Headers(incoming);
    headers.set('authorization', `Bearer ${session.accessToken}`);
    headers.set('x-pm-uid', session.uid);
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
