import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
    exclude: ['node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    setupFiles: ['./tests/setup-polyfills.ts'],
  },
});
