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
    expect(() => new AtRestCipher(MASTER, 'folder-cache').open(sealed)).toThrow(/unable to authenticate/i);
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

  it('opens a blob with a new instance of the same purpose', () => {
    const sealed = new AtRestCipher(MASTER, 'inbox').seal(new Uint8Array([9, 8, 7]));
    expect([...new AtRestCipher(MASTER, 'inbox').open(sealed)]).toEqual([9, 8, 7]);
  });

  it('opens a pinned known-answer blob (key derivation and layout are stable)', () => {
    const pinned = 'X0x6Vj41PzfNgg0Ugi9gKWAcqjrHLsFeRQxouDAKOdtJmFAZQajyJaAx0foKTOPRIviqaFZmC9OO';
    const c = new AtRestCipher(MASTER, 'inbox');
    expect(c.open(Buffer.from(pinned, 'base64')).toString('utf8')).toBe('Northwind Energy invoice 0042');
  });

  it('rejects a too-short blob', () => {
    const c = new AtRestCipher(MASTER, 'inbox');
    expect(() => c.open(new Uint8Array(20))).toThrow(/too short/);
  });

  it('rejects a flipped byte inside the tag', () => {
    const c = new AtRestCipher(MASTER, 'inbox');
    const sealed = c.seal(new Uint8Array([1, 2, 3]));
    sealed[20] ^= 0xff;
    expect(() => c.open(sealed)).toThrow(/unable to authenticate/i);
  });

  it('round-trips empty plaintext', () => {
    const c = new AtRestCipher(MASTER, 'inbox');
    expect(c.open(c.seal(new Uint8Array(0))).length).toBe(0);
  });

  describe('associated data', () => {
    const aad = (s: string) => new TextEncoder().encode(s);

    it('round-trips with the same associated data', () => {
      const c = new AtRestCipher(MASTER, 'documents');
      const sealed = c.seal(aad('Northwind Energy'), aad('row-1\0original_name'));
      expect(c.open(sealed, aad('row-1\0original_name')).toString('utf8')).toBe('Northwind Energy');
    });

    it('refuses to open under different or missing associated data', () => {
      const c = new AtRestCipher(MASTER, 'documents');
      const sealed = c.seal(aad('Northwind Energy'), aad('row-1\0original_name'));
      expect(() => c.open(sealed, aad('row-2\0original_name'))).toThrow(/unable to authenticate/i);
      expect(() => c.open(sealed, aad('row-1\0filed_name'))).toThrow(/unable to authenticate/i);
      expect(() => c.open(sealed)).toThrow(/unable to authenticate/i);
    });

    it('leaves blobs sealed without it as they were', () => {
      const c = new AtRestCipher(MASTER, 'inbox');
      expect(() => c.open(c.seal(aad('x')), aad('row-1'))).toThrow(/unable to authenticate/i);
    });
  });
});
