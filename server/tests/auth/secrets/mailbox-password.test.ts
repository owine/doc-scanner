import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import { MailboxSecret } from '../../../src/auth/secrets/mailbox-password.js';

describe('MailboxSecret', () => {
  const SAMPLE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  it('use() provides the underlying bytes', async () => {
    const secret = new MailboxSecret(SAMPLE);
    const length = await secret.use(async (bytes) => bytes.length);
    expect(length).toBe(8);
  });

  it('dispose() zeroes the buffer', async () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    const secret = new MailboxSecret(buf);
    secret.dispose();
    expect(Array.from(buf)).toEqual([0, 0, 0, 0]);
  });

  it('toJSON returns [REDACTED]', () => {
    const secret = new MailboxSecret(SAMPLE);
    expect(secret.toJSON()).toBe('[REDACTED]');
  });

  it('inspect.custom returns [REDACTED]', () => {
    const secret = new MailboxSecret(SAMPLE);
    expect(inspect(secret)).toBe('[REDACTED]');
  });

  it('JSON.stringify of containing object hides bytes', () => {
    const secret = new MailboxSecret(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    const out = JSON.stringify({ x: secret });
    expect(out).not.toContain('deadbeef');
    expect(out).not.toContain('222');
    expect(out).toContain('[REDACTED]');
  });

  it('util.inspect of containing object hides bytes', () => {
    const secret = new MailboxSecret(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    const out = inspect({ x: secret });
    expect(out).not.toContain('deadbeef');
    expect(out).toContain('[REDACTED]');
  });
});
