import type { OcrWord } from '../scanner/types.js';

export type { OcrWord };

export interface OcrResult {
  text: string;
  words: OcrWord[];
}

// postMessage protocol with the Web Worker

export type WorkerInput =
  | { type: 'init' }
  | { type: 'recognize'; jobId: string; blob: Blob }
  | { type: 'terminate' };

export type WorkerOutput =
  | { type: 'ready' }
  | { type: 'progress'; jobId: string; pct: number }
  | { type: 'result'; jobId: string; text: string; words: OcrWord[] }
  | { type: 'error'; jobId: string; message: string };

// Per-job lifecycle states tracked by the queue (UI display only).
export type OcrJobPhase = 'queued' | 'recognizing' | 'building' | 'done' | 'partial' | 'failed';
