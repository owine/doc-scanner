import { useState } from 'preact/hooks';
import { MAX_UPLOAD_BYTES, type UploadQueue } from '../../uploads/queue.js';
import type { UploadItem } from '../../uploads/types.js';
import { StateDot } from './StateDot.js';
import type { Scan } from '../../scanner/types.js';

/** The item's state, announced when it changes. Never the percentage: that would be read out on every step. */
function status(item: UploadItem, queue: UploadQueue): string {
  if (item.state === 'failed') return item.error ?? 'The upload failed.';
  if (queue.isSending(item.id)) return 'Uploading…';
  if (navigator.onLine === false) return 'Waiting for a connection';
  return item.attempts > 0 ? 'Retrying soon' : 'Waiting to upload';
}

export function UploadRow({ item, queue }: { item: UploadItem; queue: UploadQueue }) {
  const nameId = `upload-name-${item.id}`;
  const sending = queue.isSending(item.id);
  const progress = queue.progressOf(item.id) ?? 0;
  return (
    <li class="doc-row">
      <StateDot state={item.state === 'failed' ? 'bad' : 'work'} />
      <div class="doc-main">
        <div class="doc-name" id={nameId}>
          {item.name}
        </div>
        <div class={item.state === 'failed' ? 'error-text' : 'muted'}>
          <span role="status">{status(item, queue)}</span>
          {/* Outside the live region: shown, and on the progress bar, but not announced. */}
          {sending && <span> {Math.round(progress * 100)}%</span>}
        </div>
        {sending && <progress max={1} value={progress} aria-labelledby={nameId} />}
      </div>
      {item.state === 'failed' && item.size <= MAX_UPLOAD_BYTES && (
        <button
          type="button"
          class="btn btn-small"
          aria-describedby={nameId}
          onClick={() => {
            // The error's name only: never the file's.
            queue.retry(item.id).catch((e: unknown) => console.error('could not retry the upload', (e as Error)?.name));
          }}
        >
          Retry
        </button>
      )}
      {item.state === 'failed' && (
        <button
          type="button"
          class="btn btn-secondary btn-small"
          aria-describedby={nameId}
          onClick={() => {
            queue.remove(item.id).catch((e: unknown) => console.error('could not remove the upload', (e as Error)?.name));
          }}
        >
          Remove
        </button>
      )}
    </li>
  );
}

export interface DeviceScanRowProps {
  scan: Scan;
  onSend: () => Promise<void>;
  onDelete: () => Promise<void>;
  /**
   * Why the last send failed. Kept by the upload queue, not the row: sending
   * claims the scan at once, so this row unmounts and a fresh one comes back.
   */
  error?: string | null | undefined;
}

export function DeviceScanRow({ scan, onSend, onDelete, error = null }: DeviceScanRowProps) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const nameId = `scan-name-${scan.id}`;
  const dateId = `scan-date-${scan.id}`;
  // The date too: two scans of the same length must be told apart.
  const describedBy = `${nameId} ${dateId}`;
  async function run(action: () => Promise<void>, what: string) {
    setBusy(true);
    setFailed(null);
    try {
      await action();
    } catch {
      setFailed(what);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li class="doc-row">
      <StateDot state="idle" />
      <div class="doc-main">
        <div class="doc-name" id={nameId}>
          Scan · {scan.pageCount} {scan.pageCount === 1 ? 'page' : 'pages'}
        </div>
        <div class="muted" id={dateId}>
          {new Date(scan.updatedAt).toLocaleString()}
        </div>
        {(failed ?? error) && <div class="error-text">{failed ?? error}</div>}
      </div>
      <button type="button" class="btn btn-small" disabled={busy} aria-describedby={describedBy} onClick={() => void run(onSend, 'Could not send this scan. Try again.')}>
        Send to inbox
      </button>
      <button
        type="button"
        class="btn btn-secondary btn-small"
        disabled={busy}
        aria-describedby={describedBy}
        onClick={() => {
          if (window.confirm('Delete this scan from this device?')) void run(onDelete, 'Could not delete this scan.');
        }}
      >
        Delete
      </button>
    </li>
  );
}
