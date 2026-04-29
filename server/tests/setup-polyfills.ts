// Test-time polyfill installation. Production path runs the polyfill via
// the first import of server/src/index.ts; vitest never evaluates index.ts,
// so we hook it up here as a setup file (referenced from vitest.config.ts
// and vitest.integration.config.ts).
import '../src/polyfills/typed-array-base64.js';
