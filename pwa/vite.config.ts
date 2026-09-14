import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // jscanify is loaded via <script> tag from /scanner/jscanify.js, not bundled.
          if (id.includes('/scanner/edge-detect') || id.includes('/scanner/scanner-session')) return 'scanner-core';
          if (id.includes('/ocr/queue') || id.includes('/ocr/worker-client') || id.includes('/pdf/build')) return 'ocr-core';
        },
      },
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.ts'],
    server: {
      // @cantoo/pdf-lib >= 2.11 vendored @pdf-lib/standard-fonts, and its ESM build
      // imports the font metrics as bare `.json` with no `with { type: 'json' }`.
      // Node's native ESM loader rejects that, and Vitest externalizes node_modules
      // by default — so let Vite transform the package instead. The production build
      // is unaffected (Rollup inlines the JSON at bundle time).
      deps: { inline: ['@cantoo/pdf-lib'] },
    },
  } as any,
});
