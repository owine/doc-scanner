import { useEffect, useRef, useState } from 'preact/hooks';
import type { Quad, Point } from '../scanner/types.js';

export interface EditCornersScreenProps {
  canvas: HTMLCanvasElement;
  initialQuad: Quad;
  onCancel: () => void;
  onApply: (quad: Quad) => void;
}

const HANDLE_RADIUS = 14;

function quadIsValid(q: Quad): boolean {
  const a = signedArea([q.tl, q.tr, q.br, q.bl]);
  return Math.abs(a) > 100;
}

function signedArea(pts: Point[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function EditCornersScreen({ canvas, initialQuad, onCancel, onApply }: EditCornersScreenProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [quad, setQuad] = useState<Quad>(initialQuad);
  const [scale, setScale] = useState(1);
  const [dragKey, setDragKey] = useState<keyof Quad | null>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    wrapRef.current.appendChild(canvas);
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.style.display = 'block';
    const observe = () => {
      const rect = canvas.getBoundingClientRect();
      setScale(rect.width / canvas.width || 1);
    };
    observe();
    window.addEventListener('resize', observe);
    return () => { window.removeEventListener('resize', observe); canvas.remove(); };
  }, [canvas]);

  function onPointerDown(key: keyof Quad) {
    return (e: PointerEvent) => {
      e.preventDefault();
      setDragKey(key);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    };
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragKey || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    setQuad((q) => ({ ...q, [dragKey]: { x: clamp(x, 0, canvas.width), y: clamp(y, 0, canvas.height) } }));
  }

  function onPointerUp() { setDragKey(null); }

  const valid = quadIsValid(quad);

  return (
    <main style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: 12, background: 'var(--bg-elev)', borderBottom: '1px solid var(--border)' }}>
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <strong>Adjust corners</strong>
        <span style={{ width: 60 }} />
      </header>
      <div ref={wrapRef} style={{ flex: 1, position: 'relative', padding: 12, overflow: 'auto' }}
           onPointerMove={onPointerMove}
           onPointerUp={onPointerUp}>
        {(['tl', 'tr', 'bl', 'br'] as const).map((k) => (
          <div
            key={k}
            onPointerDown={onPointerDown(k)}
            style={{
              position: 'absolute', width: HANDLE_RADIUS * 2, height: HANDLE_RADIUS * 2,
              borderRadius: '50%', background: 'var(--accent)', border: '2px solid #fff',
              left: quad[k].x * scale - HANDLE_RADIUS + 12,
              top: quad[k].y * scale - HANDLE_RADIUS + 12,
              touchAction: 'none', cursor: 'grab',
            }}
            aria-label={`Corner ${k}`}
          />
        ))}
      </div>
      <footer style={{ display: 'flex', gap: 8, padding: 12, background: 'var(--bg-elev)', borderTop: '1px solid var(--border)' }}>
        <button class="btn btn-secondary" style={{ flex: 1 }} onClick={onCancel}>Cancel</button>
        <button class="btn" style={{ flex: 1 }} onClick={() => onApply(quad)} disabled={!valid}>Apply</button>
      </footer>
      {!valid && <p class="error-text" style={{ textAlign: 'center', padding: 4 }}>Corners must form a quadrilateral</p>}
    </main>
  );
}

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
