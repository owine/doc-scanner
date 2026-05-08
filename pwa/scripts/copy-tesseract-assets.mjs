// Copies tesseract.js worker + tesseract.js-core wasm bundles into
// pwa/public/ocr/ so the PWA can load them from the same origin instead
// of tesseract.js's default CDN (cdn.jsdelivr.net). The CDN path fails on
// iOS Safari behind our Service Worker (and on offline first-loads), so
// we vendor at build time. Files are gitignored — source of truth is the
// pinned versions in package-lock.json.
//
// Run automatically via `predev` and `prebuild` hooks in pwa/package.json.

import { copyFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pwaRoot = resolve(__dirname, '..');
const repoRoot = resolve(pwaRoot, '..');
const targetDir = resolve(pwaRoot, 'public/ocr');

// node_modules is hoisted to the repo root in this workspace.
const FILES = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm', 'tesseract-core-lstm.wasm'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm', 'tesseract-core-simd-lstm.wasm'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
];

await mkdir(targetDir, { recursive: true });
for (const [src, dst] of FILES) {
  await copyFile(resolve(repoRoot, src), resolve(targetDir, dst));
  process.stdout.write(`  copied ${dst}\n`);
}
