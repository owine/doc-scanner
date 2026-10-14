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
  onDone: (scanId: string) => void;
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
    const session = sessionRef.current;
    if (!session) return;
    const scanId = session.scanId;
    await session.finish();
    onDone(scanId);
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
        <div class="actions">
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
    <main class="camera">
      <header class="camera-bar">
        <button class="btn btn-secondary" onClick={cancel}>← Cancel</button>
        <div class="camera-title">Page {pageCount + 1}</div>
        <button class={autoCapture ? 'btn btn-small' : 'btn btn-secondary btn-small'} onClick={toggleAuto} aria-pressed={autoCapture}>
          Auto {autoCapture ? 'on' : 'off'}
        </button>
      </header>
      <div class="camera-view">
        <video ref={videoRef} class="camera-video" playsInline muted autoPlay />
        <div class={stability === 'stable' ? 'camera-hint camera-hint--stable' : 'camera-hint'}>{stabilityMsg}</div>
        {SHOW_DIAGNOSTICS && (
          <div class="camera-diag">
            <div>frames: {diag.frames} · stab: {stability} · canvas: {diag.canvasW}×{diag.canvasH}</div>
            <div>contour pts: {diag.contourPts} · quad: {diag.lastQuad ? 'detected' : 'none'}</div>
            {diag.lastErr && <div class="camera-diag-err">err: {diag.lastErr}</div>}
          </div>
        )}
      </div>
      <footer class="camera-foot">
        <span class="muted camera-count">Pages: {pageCount}</span>
        <button aria-label="Capture" class="shutter" onClick={shutter}>
          <span class="shutter-dot" aria-hidden="true" />
        </button>
        <button class="btn" onClick={done} disabled={pageCount === 0}>Done →</button>
      </footer>
    </main>
  );
}
