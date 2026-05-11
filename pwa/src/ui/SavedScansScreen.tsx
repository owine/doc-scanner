import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { ScansStore } from '../scanner/scans-store.js';
import { ESTIMATED_PAGE_BYTES, type Scan } from '../scanner/types.js';
import { downloadPdf } from './download.js';

export interface SavedScansScreenProps {
  store: ScansStore;
  onBack: () => void;
  onNewScan: () => void;
  onView: (scanId: string) => void;
  /**
   * Slice 4: invoked when the user taps "Retry all". Caller is expected to
   * trigger a drain (typically by posting {request-drain} to the SW or by
   * calling outbox-drain.drain directly).
   */
  onRetryAll?: () => void | Promise<void>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `Today, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return d.toLocaleString();
}

function renderRowStatus(s: Scan): JSX.Element {
  switch (s.uploadStatus) {
    case 'pending_classify':
      return <span class="muted">Processing…</span>;
    case 'awaiting_confirm':
      return <span class="muted">Awaiting confirmation</span>;
    case 'pending_upload':
      return <span class="muted">Uploading…</span>;
    case 'needs_attention':
      return <span class="error-text">Needs attention{s.uploadError ? `: ${s.uploadError}` : ''}</span>;
    case 'done':
      return <span class="muted">Saved to Drive</span>;
    case 'idle':
    default:
      return s.pdfKey ? <span class="muted">PDF ready</span> : <span class="muted">Saved</span>;
  }
}

function rowAction(s: Scan, store: ScansStore): JSX.Element | null {
  if (s.driveWebUrl) {
    return (
      <a class="btn" href={s.driveWebUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
        Open
      </a>
    );
  }
  if (s.pdfKey) {
    return (
      <button
        class="btn"
        onClick={(e) => { e.stopPropagation(); void downloadPdf(s, store); }}
      >
        Download
      </button>
    );
  }
  return null;
}

export function SavedScansScreen({ store, onBack, onNewScan, onView, onRetryAll }: SavedScansScreenProps) {
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [retrying, setRetrying] = useState(false);

  async function reload() {
    const list = await store.listCompleted();
    setScans(list);
    const t: Record<string, string> = {};
    for (const s of list) {
      if (!s.thumbnailKey) continue;
      const blob = await store.getThumbnailBlob(s.thumbnailKey);
      if (blob) t[s.id] = URL.createObjectURL(blob);
    }
    setThumbs(t);
  }

  useEffect(() => {
    reload();
    return () => Object.values(thumbs).forEach(URL.revokeObjectURL);
  }, []);

  async function del(scanId: string) {
    if (!window.confirm('Delete this scan?')) return;
    await store.delete(scanId);
    await reload();
  }

  async function handleRetryAll() {
    setRetrying(true);
    try {
      // Move every needs_attention scan back to pending_upload (resetting
      // retry counters). The drain triggered by onRetryAll will then
      // process them.
      const list = scans ?? [];
      for (const s of list) {
        if (s.uploadStatus !== 'needs_attention') continue;
        try {
          await store.setUploadStatus(s.id, 'pending_upload', { retryCount: 0, uploadError: null });
        } catch (err) {
          console.warn('retry-all: transition failed for', s.id, err);
        }
      }
      await onRetryAll?.();
      await reload();
    } finally {
      setRetrying(false);
    }
  }

  const list = scans ?? [];
  const pendingCount = list.filter((s) =>
    s.uploadStatus === 'pending_classify' || s.uploadStatus === 'pending_upload',
  ).length;
  const needsAttentionCount = list.filter((s) => s.uploadStatus === 'needs_attention').length;
  const showOutboxBanner = pendingCount > 0 || needsAttentionCount > 0;

  return (
    <main style={{ minHeight: '100dvh', background: 'var(--bg)' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: 12, background: 'var(--bg-elev)', borderBottom: '1px solid var(--border)' }}>
        <button class="btn btn-secondary" onClick={onBack}>← Back</button>
        <strong>Saved Scans</strong>
        <span style={{ width: 60 }} />
      </header>
      {showOutboxBanner && (
        <div
          aria-label="outbox status"
          style={{
            padding: 10, background: needsAttentionCount > 0 ? '#fff3cd' : '#e2e3e5',
            color: needsAttentionCount > 0 ? '#856404' : '#383d41',
            display: 'flex', alignItems: 'center', gap: 12,
            borderBottom: '1px solid var(--border)', fontSize: 13,
          }}
        >
          <span style={{ flex: 1 }}>
            {pendingCount > 0 && <>{pendingCount} processing</>}
            {pendingCount > 0 && needsAttentionCount > 0 && ' · '}
            {needsAttentionCount > 0 && <>{needsAttentionCount} need attention</>}
          </span>
          {needsAttentionCount > 0 && (
            <button class="btn" disabled={retrying} onClick={handleRetryAll}>
              {retrying ? 'Retrying…' : 'Retry all'}
            </button>
          )}
        </div>
      )}
      <button class="btn" style={{ width: '100%', borderRadius: 0 }} onClick={onNewScan}>+ New Scan</button>
      {scans === null ? (
        <p style={{ padding: 16 }} class="muted">Loading…</p>
      ) : scans.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center' }} class="muted">
          <p>No saved scans yet.</p>
          <button class="btn" onClick={onNewScan}>+ Start your first scan</button>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {scans.map((s) => (
            <li key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, borderBottom: '1px solid var(--border)' }}>
              <button onClick={() => onView(s.id)} style={{ all: 'unset', cursor: 'pointer', flex: 1, display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 40, aspectRatio: '4/5', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                  {thumbs[s.id] && <img src={thumbs[s.id]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{s.finalName ?? `Scan · ${s.pageCount} ${s.pageCount === 1 ? 'page' : 'pages'}`}</div>
                  <div class="muted" style={{ fontSize: 12 }}>{formatTime(s.updatedAt)} · {formatBytes(s.pageCount * ESTIMATED_PAGE_BYTES)}</div>
                  <div style={{ fontSize: 12 }}>{renderRowStatus(s)}</div>
                </div>
              </button>
              {rowAction(s, store)}
              <button class="btn btn-danger" aria-label="Delete" onClick={() => del(s.id)}>🗑</button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
