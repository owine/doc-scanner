// @protontech/crypto (a peer of @protontech/drive-sdk >=0.15) ships raw .ts
// source with no bundled .d.ts, so tsc type-checks its source directly. That
// source uses the TC39 Uint8Array.prototype.toHex proposal. At runtime this is
// provided by our own polyfill (src/polyfills/typed-array-base64.ts, loaded
// first in src/index.ts and in tests/setup-polyfills.ts) — NOT by core-js, so
// do not remove that polyfill. Declare the method here so the project type-checks.
interface Uint8Array {
  toHex(): string;
}
