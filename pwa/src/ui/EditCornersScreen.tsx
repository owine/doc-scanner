import { useEffect, useRef, useState } from 'preact/hooks';
import type { Quad, Point } from '../scanner/types.js';

export interface EditCornersScreenProps {
  canvas: HTMLCanvasElement;
  initialQuad: Quad;
  onCancel: () => void;
  onApply: (quad: Quad) => void;
}

/** Half the handle's 44 px touch target, centred on the corner; the visible ring is 28 px. */
const HANDLE_HIT_RADIUS = 22;

function quadIsValid(q: Quad): boolean {
  const a = signedArea([q.tl, q.tr, q.br, q.bl]);
  return Math.abs(a) > 100;
}

function signedArea(pts: Point[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function EditCornersScreen({ canvas, initialQuad, onCancel, onApply }: EditCornersScreenProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [quad, setQuad] = useState<Quad>(initialQuad);
  const [dragKey, setDragKey] = useState<keyof Quad | null>(null);
  // Where the canvas is rendered (object-fit: contain semantics) inside its
  // container, so the corner handles can be positioned in the visible image.
  const [render, setRender] = useState({ scale: 1, offsetX: 0, offsetY: 0 });

  useEffect(() => {
    if (!wrapRef.current) return;
    wrapRef.current.appendChild(canvas);
    canvas.style.display = 'block';
    canvas.style.maxWidth = '100%';
    canvas.style.maxHeight = '100%';
    canvas.style.width = 'auto';
    canvas.style.height = 'auto';
    canvas.style.objectFit = 'contain';
    const observe = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const wrapW = wrap.clientWidth;
      const wrapH = wrap.clientHeight;
      const s = Math.min(wrapW / canvas.width, wrapH / canvas.height);
      const displayedW = canvas.width * s;
      const displayedH = canvas.height * s;
      const offsetX = (wrapW - displayedW) / 2;
      const offsetY = (wrapH - displayedH) / 2;
      canvas.style.width = `${displayedW}px`;
      canvas.style.height = `${displayedH}px`;
      setRender({ scale: s, offsetX, offsetY });
    };
    observe();
    // The wrapper resizes without the window too: the invalid-corners message, font loads, dvh.
    const wrap = wrapRef.current;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(observe);
    if (ro) ro.observe(wrap); else window.addEventListener('resize', observe);
    return () => { ro?.disconnect(); window.removeEventListener('resize', observe); canvas.remove(); };
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
    const x = (e.clientX - rect.left - render.offsetX) / render.scale;
    const y = (e.clientY - rect.top - render.offsetY) / render.scale;
    setQuad((q) => ({ ...q, [dragKey]: { x: clamp(x, 0, canvas.width), y: clamp(y, 0, canvas.height) } }));
  }

  function onPointerUp() { setDragKey(null); }

  const valid = quadIsValid(quad);

  return (
    <main class="camera">
      <header class="camera-bar">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <strong class="camera-title">Adjust corners</strong>
        <span />
      </header>
      <div ref={wrapRef} class="corners-view" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        {(['tl', 'tr', 'bl', 'br'] as const).map((k) => (
          <div
            key={k}
            class="corner-handle"
            onPointerDown={onPointerDown(k)}
            // Strings with units: Preact 11's core no longer appends "px" to numbers
            // (only preact/compat does), and browsers ignore a unitless length.
            style={{
              left: `${quad[k].x * render.scale + render.offsetX - HANDLE_HIT_RADIUS}px`,
              top: `${quad[k].y * render.scale + render.offsetY - HANDLE_HIT_RADIUS}px`,
            }}
            aria-label={`Corner ${k}`}
          />
        ))}
      </div>
      <footer class="camera-foot camera-foot--split">
        <button class="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button class="btn" onClick={() => onApply(quad)} disabled={!valid}>Apply</button>
      </footer>
      {!valid && <p class="camera-error">Corners must form a quadrilateral</p>}
    </main>
  );
}

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
