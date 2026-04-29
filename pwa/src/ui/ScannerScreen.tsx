import { useEffect, useRef, useState } from 'preact/hooks';
import { ScansStore } from '../scanner/scans-store.js';
import { ScannerSession, defaultQuad } from '../scanner/scanner-session.js';
import type { StabilityState } from '../scanner/stability.js';
import type { Quad } from '../scanner/types.js';
import { CameraError } from '../scanner/camera.js';
import { EditCornersScreen } from './EditCornersScreen.js';

// Diagnostic flag: shows scanner pipeline state in the viewfinder.
// Flip to true when debugging real-device detection issues.
const SHOW_DIAGNOSTICS = false;

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
  const [diag, setDiag] = useState({
    frames: 0,
    lastQuad: null as Quad | null,
    lastErr: null as string | null,
    canvasW: 0,
    canvasH: 0,
    contourPts: 0,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const events = {
          onStability: (s: StabilityState, q: Quad | null, fd?: { canvasW: number; canvasH: number; contourPts: number }) => {
            setStability(s);
            setDiag((d) => ({
              ...d,
              frames: d.frames + 1,
              lastQuad: q,
              canvasW: fd?.canvasW ?? d.canvasW,
              canvasH: fd?.canvasH ?? d.canvasH,
              contourPts: fd?.contourPts ?? d.contourPts,
            }));
          },
          onPageAdded: () => setPageCount((c) => c + 1),
          onError: (err: Error) => setDiag((d) => ({ ...d, lastErr: err.message })),
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

  // When EditCornersScreen unmounts and we return to the scanner, the previous
  // video element is gone — re-bind the live stream to the newly-mounted one.
  useEffect(() => {
    if (!pendingEdit && videoRef.current && sessionRef.current) {
      sessionRef.current.rebindVideo(videoRef.current);
    }
  }, [pendingEdit]);

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
    <main style={{
      display: 'flex', flexDirection: 'column', height: '100dvh', background: '#000',
      paddingTop: 'env(safe-area-inset-top)',
      paddingBottom: 'env(safe-area-inset-bottom)',
    }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: 8, color: '#fff' }}>
        <button class="btn btn-secondary" onClick={cancel} style={{ background: 'rgba(255,255,255,0.1)', borderColor: '#444', color: '#fff' }}>← Cancel</button>
        <div style={{ fontWeight: 600 }}>Page {pageCount + 1}</div>
        <button
          class={autoCapture ? 'btn' : 'btn btn-secondary'}
          onClick={toggleAuto}
          aria-pressed={autoCapture}
          style={autoCapture ? {} : { background: 'rgba(255,255,255,0.1)', borderColor: '#444', color: '#fff' }}
        >Auto {autoCapture ? 'on' : 'off'}</button>
      </header>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0 }}>
        <video ref={videoRef} playsInline muted autoPlay style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        <div style={{
          position: 'absolute', top: 12, left: 0, right: 0, textAlign: 'center',
          color: stability === 'stable' ? '#4ade80' : '#fbbf24', fontWeight: 600,
          textShadow: '0 1px 3px rgba(0,0,0,0.7)',
        }}>
          {stabilityMsg}
        </div>
        {SHOW_DIAGNOSTICS && (
          <div style={{
            position: 'absolute', bottom: 8, left: 8, right: 8,
            background: 'rgba(0,0,0,0.7)', color: '#aaffaa',
            fontFamily: 'monospace', fontSize: 11, padding: 6, borderRadius: 4,
            lineHeight: 1.4,
          }}>
            <div>frames: {diag.frames} · stab: {stability} · canvas: {diag.canvasW}×{diag.canvasH}</div>
            <div>contour pts: {diag.contourPts} · quad: {diag.lastQuad ? 'detected' : 'none'}</div>
            {diag.lastErr && <div style={{ color: '#ff8888' }}>err: {diag.lastErr}</div>}
          </div>
        )}
      </div>
      <footer style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', padding: 12, background: '#111', color: '#fff' }}>
        <span class="muted">Pages: {pageCount}</span>
        <button
          aria-label="Capture"
          onClick={shutter}
          style={{ width: 64, height: 64, borderRadius: '50%', border: '4px solid #fff', background: 'rgba(255,255,255,0.18)', justifySelf: 'center' }}
        />
        <button class="btn" onClick={done} disabled={pageCount === 0} style={{ justifySelf: 'end' }}>Done →</button>
      </footer>
    </main>
  );
}
