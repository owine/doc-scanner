/// <reference lib="webworker" />
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';
import type { OcrWord, WorkerInput, WorkerOutput } from './types.js';

const OCR_LANGUAGE = 'eng';
const OCR_MIN_WORD_CONFIDENCE = 30;

let tess: TesseractWorker | null = null;

function post(msg: WorkerOutput): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

async function init(): Promise<void> {
  if (tess) return;
  tess = await createWorker(OCR_LANGUAGE, undefined, {
    // Tesseract.js's defaults point at cdn.jsdelivr.net for the inner worker
    // script and core wasm — that path hangs on iOS Safari behind our Service
    // Worker (cross-origin importScripts in a Worker is restricted, and the
    // SW also doesn't have a fetch handler for the CDN host). pwa/scripts/
    // copy-tesseract-assets.mjs vendors the files to /ocr/ at build time.
    langPath: '/ocr',
    gzip: true,
    workerPath: '/ocr/worker.min.js',
    corePath: '/ocr',
  });
}

self.onmessage = async (e: MessageEvent<WorkerInput>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      await init();
      post({ type: 'ready' });
    } catch (err) {
      post({ type: 'error', jobId: 'init', message: (err as Error).message });
    }
    return;
  }
  if (msg.type === 'terminate') {
    if (tess) { await tess.terminate(); tess = null; }
    return;
  }
  if (msg.type === 'recognize') {
    if (!tess) {
      post({ type: 'error', jobId: msg.jobId, message: 'worker not initialized' });
      return;
    }
    try {
      // Request blocks so we can extract the word list (words live in
      // blocks[].paragraphs[].lines[].words[] — there is no top-level words field).
      const result = await tess.recognize(msg.blob, {}, { text: true, blocks: true });
      const rawWords = (result.data.blocks ?? []).flatMap((b) =>
        b.paragraphs.flatMap((p) =>
          p.lines.flatMap((l) => l.words),
        ),
      );
      const words: OcrWord[] = rawWords
        .filter((w) => (w.confidence ?? 0) >= OCR_MIN_WORD_CONFIDENCE)
        .map((w) => ({
          text: w.text,
          x: w.bbox.x0,
          y: w.bbox.y0,
          w: w.bbox.x1 - w.bbox.x0,
          h: w.bbox.y1 - w.bbox.y0,
          confidence: w.confidence ?? 0,
        }));
      post({ type: 'result', jobId: msg.jobId, text: result.data.text ?? '', words });
    } catch (err) {
      post({ type: 'error', jobId: msg.jobId, message: (err as Error).message });
    }
  }
};
