export type UploadSource = 'picker' | 'scanner';

/** A file waiting to reach the server. Kept in IndexedDB until the server has it. */
export interface UploadItem {
  id: string;
  name: string;
  size: number;
  blob: Blob;
  source: UploadSource;
  /** For a scan: the local scan to delete once the server has accepted the upload. */
  scanId: string | null;
  createdAt: number;
  attempts: number;
  /** 'failed' is permanent (the server refused the file) until the user retries. */
  state: 'queued' | 'failed';
  /** Shown to the user when failed. Never a file name. */
  error: string | null;
  nextAttemptAt: number;
}
