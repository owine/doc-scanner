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
        },
      },
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.ts'],
  } as any,
});
