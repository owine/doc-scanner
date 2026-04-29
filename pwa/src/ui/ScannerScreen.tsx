import { useEffect, useRef, useState } from 'preact/hooks';
import { ScansStore } from '../scanner/scans-store.js';
import { ScannerSession, defaultQuad } from '../scanner/scanner-session.js';
import type { StabilityState } from '../scanner/stability.js';
import type { Quad } from '../scanner/types.js';
import { CameraError } from '../scanner/camera.js';
import { EditCornersScreen } from './EditCornersScreen.js';

const AUTO_CAPTURE_KEY = 'auto_capture_enabled';

export interface ScannerScreenProps {
  store: ScansStore;
  resumeScanId?: string;
  onBack: () => void;
  onDone: () => void;
}

interface PendingEdit {
  canvas: HTMLCanvasElement;
  initialQuad: Quad;
}

export function ScannerScreen({ store, resumeScanId, onBack, onDone }: ScannerScreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<ScannerSession | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [stability, setStability] = useState<StabilityState>('searching');
  const [autoCapture, setAutoCapture] = useState(() => localStorage.getItem(AUTO_CAPTURE_KEY) !== 'false');
  const [error, setError] = useState<string | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingEdit | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const events = {
          onStability: (s: StabilityState) => setStability(s),
          onPageAdded: () => setPageCount((c) => c + 1),
        };
        const session = resumeScanId
          ? await ScannerSession.resume(resumeScanId, store, events)
          : await ScannerSession.start(store, events);
        if (cancelled) { session.stop(); return; }
        sessionRef.current = session;
        if (resumeScanId) {
          const pages = await store.getPages(resumeScanId);
          setPageCount(pages.length);
        }
        session.setAutoCapture(autoCapture);
        if (videoRef.current) await session.attachVideo(videoRef.current);
      } catch (err) {
        if (err instanceof CameraError) setError(err.message);
        else setError(String((err as Error).message ?? err));
      }
    })();
    return () => { cancelled = true; sessionRef.current?.stop(); };
  }, [resumeScanId]);

  function toggleAuto() {
    const next = !autoCapture;
    setAutoCapture(next);
    localStorage.setItem(AUTO_CAPTURE_KEY, String(next));
    sessionRef.current?.setAutoCapture(next);
  }

  function shutter() {
    const session = sessionRef.current;
    if (!session) return;
    const { canvas, quad } = session.manualCapture();
    setPendingEdit({ canvas, initialQuad: quad ?? defaultQuad(canvas.width, canvas.height) });
  }

  async function applyEdit(quad: Quad) {
    if (!pendingEdit) return;
    await sessionRef.current?.commitPage(pendingEdit.canvas, quad);
    setPendingEdit(null);
  }

  async function done() {
    if (pageCount === 0) {
      await sessionRef.current?.discard();
      onBack();
      return;
    }
    await sessionRef.current?.finish();
    onDone();
  }

  async function cancel() {
    await sessionRef.current?.discard();
    onBack();
  }

  if (pendingEdit) {
    return <EditCornersScreen
      canvas={pendingEdit.canvas}
      initialQuad={pendingEdit.initialQuad}
      onCancel={() => setPendingEdit(null)}
      onApply={applyEdit}
    />;
  }

  if (error) {
    return (
      <main class="auth-screen">
        <div class="warn"><strong>Camera unavailable.</strong> {error}</div>
        <p class="muted">Open Settings → Safari → Camera and allow access.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button class="btn" onClick={() => location.reload()}>Try again</button>
          <button class="btn btn-secondary" onClick={onBack}>Back</button>
        </div>
      </main>
    );
  }

  const stabilityMsg =
    stability === 'searching' ? 'Position page in view' :
    stability === 'counting' ? 'Hold steady…' :
    'Capturing…';

  return (
    <main style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#000' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: 8, color: '#fff' }}>
        <button class="btn btn-secondary" onClick={cancel}>← Cancel</button>
        <div>Page {pageCount + 1}</div>
        <button
          class={autoCapture ? 'btn' : 'btn btn-secondary'}
          onClick={toggleAuto}
          aria-pressed={autoCapture}
        >Auto {autoCapture ? 'on' : 'off'}</button>
      </header>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        <div style={{
          position: 'absolute', top: 12, left: 0, right: 0, textAlign: 'center',
          color: stability === 'stable' ? '#4ade80' : '#fbbf24', fontWeight: 600,
        }}>
          {stabilityMsg}
        </div>
      </div>
      <footer style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', padding: 12, background: '#111', color: '#fff' }}>
        <span class="muted">Pages: {pageCount}</span>
        <button
          aria-label="Capture"
          onClick={shutter}
          style={{ width: 64, height: 64, borderRadius: '50%', border: '4px solid #fff', background: 'rgba(255,255,255,0.18)' }}
        />
        <button class="btn" onClick={done} disabled={pageCount === 0}>Done →</button>
      </footer>
    </main>
  );
}
