import { useEffect, useState } from 'preact/hooks';
import { ScansStore } from '../scanner/scans-store.js';
import { ESTIMATED_PAGE_BYTES, type Scan } from '../scanner/types.js';

export interface SavedScansScreenProps {
  store: ScansStore;
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

export function SavedScansScreen({ store, onBack, onNewScan, onView }: SavedScansScreenProps) {
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

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

  return (
    <main style={{ minHeight: '100vh', background: 'var(--bg)' }}>
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
                </div>
              </button>
              <button class="btn btn-danger" aria-label="Delete" onClick={() => del(s.id)}>🗑</button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
