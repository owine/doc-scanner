import type { Quad } from './types.js';

export const JPEG_QUALITY = 0.92;
export const MAX_EDGE_PX = 2200;

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(script);
  });
}

let opencvPromise: Promise<void> | null = null;

function loadOpenCV(): Promise<void> {
  if (!opencvPromise) {
    opencvPromise = new Promise<void>((resolve, reject) => {
      if ((globalThis as any).cv?.getBuildInformation) { resolve(); return; }
      // Assign Module.onRuntimeInitialized BEFORE injecting the script so a
      // cached response whose wasm finishes before script.onload fires still
      // triggers the callback.
      (globalThis as any).Module = { onRuntimeInitialized: () => resolve() };
      const script = document.createElement('script');
      script.src = '/opencv/opencv.js';
      script.async = true;
      script.onerror = () => reject(new Error('failed to load opencv.js'));
      document.head.appendChild(script);
    });
  }
  return opencvPromise;
}

let jscanifyPromise: Promise<void> | null = null;

function loadJscanify(): Promise<void> {
  if (!jscanifyPromise) {
    jscanifyPromise = (async () => {
      if ((globalThis as any).jscanify) return;
      await injectScript('/scanner/jscanify.js');
    })();
  }
  return jscanifyPromise;
}

let modulePromise: Promise<{ scanner: any }> | null = null;

async function loadScanner() {
  if (!modulePromise) {
    modulePromise = (async () => {
      await loadOpenCV();
      await loadJscanify();
      const Scanner = (globalThis as any).jscanify;
      if (!Scanner) throw new Error('jscanify global not found after load');
      const scanner = new Scanner();
      return { scanner };
    })();
  }
  return modulePromise;
}

export interface FindQuadResult {
  quad: Quad | null;
  // Diagnostic info, surfaced to the UI overlay during development
  canvasW: number;
  canvasH: number;
  contourPts: number; // number of points in the largest contour (data32S.length / 2)
}

export async function findQuad(canvas: HTMLCanvasElement): Promise<FindQuadResult> {
  const result: FindQuadResult = { quad: null, canvasW: canvas.width, canvasH: canvas.height, contourPts: 0 };
  if (canvas.width === 0 || canvas.height === 0) return result;

  const { scanner } = await loadScanner();
  const cv = (globalThis as any).cv;
  if (!cv) return result;

  let img: any = null;
  try {
    img = cv.imread(canvas);
    const contour = scanner.findPaperContour(img);
    if (!contour || !contour.data32S) return result;
    result.contourPts = contour.data32S.length / 2;
    if (result.contourPts < 4) return result;
    const points = scanner.getCornerPoints(contour);
    if (!points?.topLeftCorner || !points?.topRightCorner || !points?.bottomLeftCorner || !points?.bottomRightCorner) {
      return result;
    }
    result.quad = {
      tl: points.topLeftCorner,
      tr: points.topRightCorner,
      bl: points.bottomLeftCorner,
      br: points.bottomRightCorner,
    };
    return result;
  } finally {
    img?.delete?.();
  }
}

export async function warpToFlat(canvas: HTMLCanvasElement, quad: Quad): Promise<Blob> {
  const { scanner } = await loadScanner();
  const warped: HTMLCanvasElement = scanner.extractPaper(
    canvas,
    canvas.width,
    canvas.height,
    {
      topLeftCorner: quad.tl,
      topRightCorner: quad.tr,
      bottomLeftCorner: quad.bl,
      bottomRightCorner: quad.br,
    },
  );
  return await downscaleToBlob(warped, MAX_EDGE_PX, JPEG_QUALITY);
}

async function downscaleToBlob(canvas: HTMLCanvasElement, maxEdge: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  const w = Math.round(canvas.width * scale);
  const h = Math.round(canvas.height * scale);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  out.getContext('2d')!.drawImage(canvas, 0, 0, w, h);
  return await new Promise<Blob>((resolve, reject) => {
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/jpeg', quality);
  });
}

export function defaultQuad(width: number, height: number): Quad {
  const insetX = width * 0.1;
  const insetY = height * 0.1;
  return {
    tl: { x: insetX, y: insetY },
    tr: { x: width - insetX, y: insetY },
    bl: { x: insetX, y: height - insetY },
    br: { x: width - insetX, y: height - insetY },
  };
}
