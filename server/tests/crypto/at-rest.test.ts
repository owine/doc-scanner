import { describe, it, expect } from 'vitest';
import { AtRestCipher } from '../../src/crypto/at-rest.js';

const MASTER = Buffer.alloc(32, 7).toString('base64');

describe('AtRestCipher', () => {
  it('round-trips bytes', () => {
    const c = new AtRestCipher(MASTER, 'inbox');
    const plain = new TextEncoder().encode('hello');
    expect(new TextDecoder().decode(c.open(c.seal(plain)))).toBe('hello');
  });

  it('uses a fresh IV each time', () => {
    const c = new AtRestCipher(MASTER, 'inbox');
    const plain = new Uint8Array([1, 2, 3]);
    expect(Buffer.compare(c.seal(plain), c.seal(plain))).not.toBe(0);
  });

  it('derives separate keys per purpose', () => {
    const sealed = new AtRestCipher(MASTER, 'inbox').seal(new Uint8Array([1]));
    expect(() => new AtRestCipher(MASTER, 'folder-cache').open(sealed)).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const c = new AtRestCipher(MASTER, 'inbox');
    const sealed = c.seal(new Uint8Array([1, 2, 3]));
    sealed[sealed.length - 1] ^= 0xff;
    expect(() => c.open(sealed)).toThrow();
  });

  it('requires a 32-byte master key', () => {
    expect(() => new AtRestCipher(Buffer.alloc(16).toString('base64'), 'inbox')).toThrow(/32 bytes/);
  });
});
