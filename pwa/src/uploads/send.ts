import type { UploadSource } from './types.js';

export interface SendInput {
  blob: Blob;
  name: string;
  source: UploadSource;
}

export interface SendResult {
  id: string;
  duplicate: boolean;
}

/** Long enough for 50 MB on a slow uplink; ends an upload that stalled (say, iOS suspended the page). */
export const UPLOAD_TIMEOUT_MS = 15 * 60_000;

export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(code ?? `upload failed (${status})`);
    // Minification renames the class; error reports are titled with this.
    this.name = 'UploadError';
  }

  /** Worth retrying: the network or the server failed, not the file. */
  get transient(): boolean {
    if (this.code === 'unreadable') return false;
    // A success or redirect that isn't the server's answer (a captive portal's
    // page, say): the file never reached the server.
    if (this.code === 'bad_response') return true;
    // 409: the server was restarting an earlier failed copy at the same moment;
    // sending again gets the duplicate answer.
    return this.status === 0 || this.status === 408 || this.status === 409 || this.status === 429 || this.status >= 500;
  }
}

export type XhrFactory = () => XMLHttpRequest;

/** One multipart POST to /api/documents. XMLHttpRequest, not fetch, for upload progress. */
export function sendDocument(
  input: SendInput,
  onProgress: (fraction: number) => void,
  xhr: XhrFactory = () => new XMLHttpRequest(),
): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    try {
      form.append('file', input.blob, input.name);
    } catch {
      // Not a Blob the browser can send. Sending again won't change that.
      reject(new UploadError(0, 'unreadable'));
      return;
    }
    form.append('source', input.source);
    form.append('originalName', input.name);

    const req = xhr();
    req.open('POST', '/api/documents');
    req.withCredentials = true;
    req.timeout = UPLOAD_TIMEOUT_MS;
    req.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    req.onload = () => {
      let body: { id?: unknown; duplicate?: unknown; error?: unknown } = {};
      try {
        body = JSON.parse(req.responseText) as typeof body;
      } catch {
        // A reverse proxy's HTML error page: classify on the status alone.
      }
      if ((req.status === 200 || req.status === 202) && typeof body.id === 'string') {
        resolve({ id: body.id, duplicate: body.duplicate === true });
      } else if (req.status >= 200 && req.status < 400) {
        reject(new UploadError(req.status, 'bad_response'));
      } else {
        reject(new UploadError(req.status, typeof body.error === 'string' ? body.error : undefined));
      }
    };
    req.onerror = () => reject(new UploadError(0, 'network'));
    req.ontimeout = () => reject(new UploadError(0, 'timeout'));
    req.send(form);
  });
}
