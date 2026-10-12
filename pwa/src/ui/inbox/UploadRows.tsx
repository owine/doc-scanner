import { useState } from 'preact/hooks';
import { MAX_UPLOAD_BYTES, type UploadQueue } from '../../uploads/queue.js';
import type { UploadItem } from '../../uploads/types.js';
import type { Scan } from '../../scanner/types.js';

function status(item: UploadItem, queue: UploadQueue): string {
  if (item.state === 'failed') return item.error ?? 'The upload failed.';
  if (queue.isSending(item.id)) return `Uploading… ${Math.round((queue.progressOf(item.id) ?? 0) * 100)}%`;
  if (navigator.onLine === false) return 'Waiting for a connection';
  return item.attempts > 0 ? 'Retrying soon' : 'Waiting to upload';
}

export function UploadRow({ item, queue }: { item: UploadItem; queue: UploadQueue }) {
  const nameId = `upload-name-${item.id}`;
  const sending = queue.isSending(item.id);
  return (
    <li class="doc-row">
      <div class="doc-main">
        <div class="doc-name" id={nameId}>
          {item.name}
        </div>
        <div class={item.state === 'failed' ? 'error-text' : 'muted'}>{status(item, queue)}</div>
        {sending && <progress max={1} value={queue.progressOf(item.id) ?? 0} aria-describedby={nameId} />}
      </div>
      {item.state === 'failed' && item.size <= MAX_UPLOAD_BYTES && (
        <button type="button" class="btn btn-small" aria-describedby={nameId} onClick={() => void queue.retry(item.id)}>
          Retry
        </button>
      )}
      {item.state === 'failed' && (
        <button type="button" class="btn btn-secondary btn-small" aria-describedby={nameId} onClick={() => void queue.remove(item.id)}>
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
   * Why the last send failed. Kept by the inbox, not the row: sending claims
   * the scan at once, so this row unmounts and a fresh one comes back.
   */
  error?: string | null | undefined;
}

export function DeviceScanRow({ scan, onSend, onDelete, error = null }: DeviceScanRowProps) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const nameId = `scan-name-${scan.id}`;
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
      <div class="doc-main">
        <div class="doc-name" id={nameId}>
          Scan · {scan.pageCount} {scan.pageCount === 1 ? 'page' : 'pages'}
        </div>
        <div class="muted">{new Date(scan.updatedAt).toLocaleString()}</div>
        {(failed ?? error) && <div class="error-text">{failed ?? error}</div>}
      </div>
      <button type="button" class="btn btn-small" disabled={busy} aria-describedby={nameId} onClick={() => void run(onSend, 'Could not send this scan. Try again.')}>
        Send to inbox
      </button>
      <button
        type="button"
        class="btn btn-secondary btn-small"
        disabled={busy}
        aria-describedby={nameId}
        onClick={() => {
          if (window.confirm('Delete this scan from this device? It has not been sent anywhere.')) void run(onDelete, 'Could not delete this scan.');
        }}
      >
        Delete
      </button>
    </li>
  );
}
