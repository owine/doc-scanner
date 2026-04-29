import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
    exclude: ['node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    setupFiles: ['./tests/setup-polyfills.ts'],
    // Run all integration test files in a single fork so they share the
    // login cached by tests/helpers/integration-session.ts. Each Proton
    // login counts against the account's "recent logins" anti-abuse budget;
    // de-duplicating across files saves us from rate-limiting ourselves.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
