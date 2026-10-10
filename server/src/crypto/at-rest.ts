import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * AES-256-GCM for data the server keeps on disk (inbox documents, the folder
 * tree). Each purpose gets its own key, derived from SESSION_ENCRYPTION_KEY
 * with HKDF, so a blob of one kind can never be opened as another and no key
 * is reused across purposes. Layout: iv (12) | tag (16) | ciphertext, the
 * same as SessionStore's.
 */
export class AtRestCipher {
  private readonly key: Buffer;

  constructor(masterKeyBase64: string, purpose: string) {
    const master = Buffer.from(masterKeyBase64, 'base64');
    if (master.length !== 32) throw new Error('AtRestCipher: master key must be 32 bytes');
    this.key = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `doc-scanner/${purpose}/v1`, 32));
  }

  seal(plaintext: Uint8Array): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }

  open(sealed: Uint8Array): Buffer {
    const iv = sealed.subarray(0, IV_LEN);
    const tag = sealed.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
  }
}
