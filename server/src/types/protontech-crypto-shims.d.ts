// @protontech/crypto (a peer of @protontech/drive-sdk >=0.15) ships raw .ts
// source with no bundled .d.ts, so tsc type-checks its source directly. That
// source uses the TC39 Uint8Array.prototype.toHex proposal, polyfilled at
// runtime via core-js. Declare it here so the project type-checks.
interface Uint8Array {
  toHex(): string;
}
