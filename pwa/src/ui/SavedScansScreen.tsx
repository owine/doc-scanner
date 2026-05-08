import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { ScansStore } from '../scanner/scans-store.js';
import { ESTIMATED_PAGE_BYTES, type Scan } from '../scanner/types.js';
import { OcrQueue, type ProgressEvent, type DoneEvent, type FailedEvent } from '../ocr/queue.js';
import { downloadPdf } from './download.js';

export interface SavedScansScreenProps {
  store: ScansStore;
  queue: OcrQueue;
  onBack: () => void;
  onNewScan: () => void;
  onView: (scanId: string) => void;
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

function renderRowStatus(s: Scan, prog: { doneCount: number; totalCount: number } | undefined): JSX.Element {
  switch (s.pdfStatus) {
    case 'done':
    case 'partial':
      return <span class="muted">PDF ready{s.pdfStatus === 'partial' ? ' (partial)' : ''}</span>;
    case 'failed':
      return <span class="error-text">Failed: {s.ocrError ?? 'unknown'}</span>;
    case 'running':
      return <span class="muted">OCR'ing {prog?.doneCount ?? 0}/{prog?.totalCount ?? s.pageCount}</span>;
    case 'pending':
    default:
      return <span class="muted">OCR queued</span>;
  }
}

function rowAction(s: Scan, queue: OcrQueue, store: ScansStore): JSX.Element | null {
  if (s.pdfStatus === 'done' || s.pdfStatus === 'partial') {
    return (
      <button
        class="btn"
        onClick={(e) => { e.stopPropagation(); void downloadPdf(s, store); }}
      >
        Download
      </button>
    );
  }
  if (s.pdfStatus === 'failed') {
    return (
      <button
        class="btn btn-secondary"
        onClick={(e) => { e.stopPropagation(); void queue.retry(s.id); }}
      >
        Retry
      </button>
    );
  }
  return null;
}

export function SavedScansScreen({ store, queue, onBack, onNewScan, onView }: SavedScansScreenProps) {
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, { doneCount: number; totalCount: number }>>({});

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

  useEffect(() => {
    const onProg = (e: ProgressEvent) => setProgress((p) => ({ ...p, [e.scanId]: { doneCount: e.doneCount, totalCount: e.totalCount } }));
    const onDone = (_: DoneEvent) => { void reload(); };
    const onFail = (_: FailedEvent) => { void reload(); };
    queue.on('progress', onProg);
    queue.on('done', onDone);
    queue.on('failed', onFail);
    // No detach — OcrQueue is app-lifetime; minor leak fine for SPA
  }, []);

  async function del(scanId: string) {
    if (!window.confirm('Delete this scan?')) return;
    queue.cancel(scanId);
    await store.delete(scanId);
    await reload();
  }

  return (
    <main style={{ minHeight: '100dvh', background: 'var(--bg)' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: 12, background: 'var(--bg-elev)', borderBottom: '1px solid var(--border)' }}>
        <button class="btn btn-secondary" onClick={onBack}>← Back</button>
        <strong>Saved Scans</strong>
        <span style={{ width: 60 }} />
      </header>
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
                  <div style={{ fontWeight: 600 }}>Scan · {s.pageCount} {s.pageCount === 1 ? 'page' : 'pages'}</div>
                  <div class="muted" style={{ fontSize: 12 }}>{formatTime(s.updatedAt)} · {formatBytes(s.pageCount * ESTIMATED_PAGE_BYTES)}</div>
                  <div style={{ fontSize: 12 }}>{renderRowStatus(s, progress[s.id])}</div>
                </div>
              </button>
              {rowAction(s, queue, store)}
              <button class="btn btn-danger" aria-label="Delete" onClick={() => del(s.id)}>🗑</button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
