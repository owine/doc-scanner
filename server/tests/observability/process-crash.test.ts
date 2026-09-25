import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runs instrument.ts in a real child process: crash semantics are process-level
// and cannot be observed in-process.
const instrument = fileURLToPath(new URL('../../src/instrument.ts', import.meta.url));

function runUnhandledRejection(env: Record<string, string>): number | null {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(instrument)}); Promise.reject(new Error('unhandled'));`],
    { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 20_000 },
  );
  return result.status;
}

describe('unhandled promise rejections', () => {
  it('still crash the process without a DSN (Node default)', () => {
    expect(runUnhandledRejection({})).not.toBe(0);
  });

  it('still crash the process with a DSN (reported, then exit — not swallowed)', () => {
    // Port 9 (discard) on loopback: the send fails fast and the SDK exits anyway.
    expect(runUnhandledRejection({ SENTRY_DSN: 'https://public@127.0.0.1:9/1' })).not.toBe(0);
  });
});
