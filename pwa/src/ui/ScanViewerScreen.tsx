import { useEffect, useState } from 'preact/hooks';
import { ScansStore } from '../scanner/scans-store.js';
import type { Page, Scan } from '../scanner/types.js';
import { OcrQueue } from '../ocr/queue.js';
import { downloadPdf } from './download.js';

export interface ScanViewerScreenProps {
  store: ScansStore;
  queue: OcrQueue;
  scanId: string;
  onBack: () => void;
}

export function ScanViewerScreen({ store, queue, scanId, onBack }: ScanViewerScreenProps) {
  const [pages, setPages] = useState<Page[]>([]);
  const [urls, setUrls] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [scanRow, setScanRow] = useState<Scan | null>(null);

  useEffect(() => {
    let revoke: string[] = [];
    store.getPages(scanId).then((p) => {
      setPages(p);
      const u = p.map((page) => URL.createObjectURL(page.blob));
      setUrls(u);
      revoke = u;
    });
    return () => revoke.forEach(URL.revokeObjectURL);
  }, [scanId]);

  useEffect(() => {
    store.listCompleted().then((all) => setScanRow(all.find((s) => s.id === scanId) ?? null));
  }, [scanId, store]);

  async function deleteScan() {
    if (!window.confirm('Delete this scan?')) return;
    await store.delete(scanId);
    onBack();
  }

  if (urls.length === 0) return <main class="auth-screen"><p class="muted">Loading…</p></main>;

  return (
    <main style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: 'var(--bg)', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: 12, background: 'var(--bg-elev)', borderBottom: '1px solid var(--border)' }}>
        <button class="btn btn-secondary" onClick={onBack}>← Back</button>
        <strong>{idx + 1} / {pages.length}</strong>
        <span style={{ display: 'flex', gap: 8 }}>
          {(scanRow?.pdfStatus === 'done' || scanRow?.pdfStatus === 'partial') && (
            <button class="btn" onClick={() => downloadPdf(scanRow, store)}>Download</button>
          )}
          <button class="btn btn-danger" aria-label="Delete scan" onClick={deleteScan}>🗑</button>
        </span>
      </header>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, overflow: 'hidden' }}>
        <img src={urls[idx]} alt={`Page ${idx + 1}`} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
      </div>
      <footer style={{ display: 'flex', gap: 8, padding: 12, background: 'var(--bg-elev)', borderTop: '1px solid var(--border)' }}>
        <button class="btn btn-secondary" disabled={idx === 0} onClick={() => setIdx((i) => i - 1)}>‹ Prev</button>
        <div style={{ flex: 1, display: 'flex', gap: 4, justifyContent: 'center' }}>
          {pages.map((_, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              style={{
                width: 24, aspectRatio: '4/5', borderRadius: 3,
                background: 'var(--bg)',
                border: i === idx ? '2px solid var(--accent)' : '1px solid var(--border)',
                cursor: 'pointer',
              }}
              aria-label={`Page ${i + 1}`}
            />
          ))}
        </div>
        <button class="btn btn-secondary" disabled={idx === pages.length - 1} onClick={() => setIdx((i) => i + 1)}>Next ›</button>
      </footer>
    </main>
  );
}
