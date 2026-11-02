import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
    exclude: ['node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    setupFiles: ['./tests/setup-polyfills.ts'],
    // Run all integration test files in ONE process so they share the login
    // cached by tests/helpers/integration-session.ts. Each Proton login counts
    // against the account's "recent logins" anti-abuse budget, and a 2FA code
    // works only once. The forks pool gives every file a fresh child process
    // unless isolation is off; `forks: { singleFork: true }`, used here before,
    // is no longer a Vitest option, so each file had silently logged in again.
    pool: 'forks',
    isolate: false,
    fileParallelism: false,
  },
});
