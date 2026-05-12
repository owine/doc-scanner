// Copies tesseract.js worker + tesseract.js-core wasm bundles into
// pwa/public/ocr/ so the PWA can load them from the same origin instead
// of tesseract.js's default CDN (cdn.jsdelivr.net). The CDN path fails on
// iOS Safari behind our Service Worker (and on offline first-loads), so
// we vendor at build time. Files are gitignored — source of truth is the
// pinned versions in pnpm-lock.yaml.
//
// Run automatically via `predev` and `prebuild` hooks in pwa/package.json.

import { copyFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pwaRoot = resolve(__dirname, '..');
const targetDir = resolve(pwaRoot, 'public/ocr');

// Under pnpm workspaces (node-linker: isolated, the default), each
// workspace has its own node_modules with only its declared deps.
// tesseract.js + tesseract.js-core are listed in pwa/package.json, so
// they live at pwa/node_modules/<pkg>/... — not the repo root.
const FILES = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm', 'tesseract-core-lstm.wasm'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm', 'tesseract-core-simd-lstm.wasm'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
];

await mkdir(targetDir, { recursive: true });
for (const [src, dst] of FILES) {
  await copyFile(resolve(pwaRoot, src), resolve(targetDir, dst));
  process.stdout.write(`  copied ${dst}\n`);
}
