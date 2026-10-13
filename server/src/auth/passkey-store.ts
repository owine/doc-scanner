import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { DB } from '../db.js';
import type { AtRestCipher } from '../crypto/at-rest.js';
import { logger } from '../logger.js';

/** `PublicKeyCredential.id` is base64url. Here it is a primary key, associated data and a URL segment. */
export const CREDENTIAL_ID = /^[A-Za-z0-9_-]{16,256}$/;

/** PRF outputs are 32 bytes, and so are the salts the server makes. */
export const PRF_BYTES = 32;

const INFO = 'docscanner-passkey-unlock';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

export interface PasskeyEntry {
  credentialId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * `unknown`: no such passkey. `wrong_secret`: the PRF output didn't open the
 * inner layer. `unreadable`: the outer layer didn't open (the env key changed,
 * or the row is corrupt); the row is removed.
 */
export type UnwrapResult = Uint8Array | 'unknown' | 'wrong_secret' | 'unreadable';

/** Strict base64url: null for anything with other characters (padding included). */
export function decodeBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

/** What logs carry of a credential id: enough to tell passkeys apart. */
export const shortId = (credentialId: string): string => credentialId.slice(0, 8);

const idAad = (credentialId: string) => Buffer.from(credentialId, 'utf8');
const labelAad = (credentialId: string) => Buffer.from(`${credentialId}\0label`, 'utf8');

/** Spec §2: HKDF-SHA256(ikm = PRF output, salt = the passkey's salt, info), 32 bytes. */
function innerKey(prf: Uint8Array, salt: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', prf, salt, INFO, 32));
}

/** AES-256-GCM, laid out like AtRestCipher's: iv (12) | tag (16) | ciphertext. */
function innerSeal(key: Buffer, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function innerOpen(key: Buffer, sealed: Uint8Array, aad: Uint8Array): Buffer {
  if (sealed.length < IV_LEN + TAG_LEN) throw new Error('passkey wrap too short');
  const decipher = createDecipheriv(ALGO, key, sealed.subarray(0, IV_LEN), { authTagLength: TAG_LEN });
  decipher.setAuthTag(sealed.subarray(IV_LEN, IV_LEN + TAG_LEN));
  decipher.setAAD(aad);
  return Buffer.concat([decipher.update(sealed.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
}

interface Row {
  credential_id: string;
  label: Uint8Array;
  salt: Uint8Array;
  wrapped: Uint8Array;
  created_at: string;
  last_used_at: string | null;
}

/**
 * Passkeys that can unlock the Proton keys after a restart (spec §2). Each
 * row wraps the mailbox passphrase twice: inside, under a key derived from
 * the passkey's PRF output, which is never stored; outside, with the
 * 'passkeys' at-rest cipher. Both layers are bound to the credential id. The
 * database alone opens nothing, and the database plus SESSION_ENCRYPTION_KEY
 * still lacks the PRF output. Never logs or returns a PRF output or the
 * passphrase; logs carry the first 8 characters of a credential id.
 */
export class PasskeyStore {
  constructor(
    private readonly db: DB,
    private readonly cipher: AtRestCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Wraps the passphrase for one passkey. Adding a credential id again replaces its row. */
  add(entry: { credentialId: string; label: string; salt: Uint8Array; prf: Uint8Array; passphrase: Uint8Array }): PasskeyEntry {
    const aad = idAad(entry.credentialId);
    const inner = innerSeal(innerKey(entry.prf, entry.salt), entry.passphrase, aad);
    const wrapped = this.cipher.seal(inner, aad);
    const label = this.cipher.seal(Buffer.from(entry.label, 'utf8'), labelAad(entry.credentialId));
    const createdAt = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO passkey_unlocks (credential_id, label, salt, wrapped, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(credential_id) DO UPDATE SET label = excluded.label, salt = excluded.salt,
           wrapped = excluded.wrapped, created_at = excluded.created_at, last_used_at = NULL`,
      )
      .run(entry.credentialId, label, entry.salt, wrapped, createdAt);
    return { credentialId: entry.credentialId, label: entry.label, createdAt, lastUsedAt: null };
  }

  /** Oldest first, labels opened. */
  list(): PasskeyEntry[] {
    const rows = this.db
      .prepare('SELECT credential_id, label, created_at, last_used_at FROM passkey_unlocks ORDER BY created_at, credential_id')
      .all() as Pick<Row, 'credential_id' | 'label' | 'created_at' | 'last_used_at'>[];
    return rows.map((r) => ({
      credentialId: r.credential_id,
      label: this.openLabel(r.credential_id, r.label),
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM passkey_unlocks').get() as { n: number }).n;
  }

  /** Every passkey with its PRF salt: what an unlock asks the authenticator to evaluate. */
  saltsFor(): { credentialId: string; salt: Uint8Array }[] {
    const rows = this.db.prepare('SELECT credential_id, salt FROM passkey_unlocks ORDER BY created_at, credential_id').all() as Pick<
      Row,
      'credential_id' | 'salt'
    >[];
    return rows.map((r) => ({ credentialId: r.credential_id, salt: r.salt }));
  }

  /** The passphrase bytes, or why not. The caller owns (and should zero) the bytes. */
  unwrap(credentialId: string, prf: Uint8Array): UnwrapResult {
    const row = this.db.prepare('SELECT salt, wrapped FROM passkey_unlocks WHERE credential_id = ?').get(credentialId) as
      | Pick<Row, 'salt' | 'wrapped'>
      | undefined;
    if (!row) return 'unknown';
    const aad = idAad(credentialId);
    let inner: Buffer;
    try {
      inner = this.cipher.open(row.wrapped, aad);
    } catch {
      // Not a wrong PRF output: this row can never open again.
      this.remove(credentialId);
      logger.warn({ credential: shortId(credentialId) }, 'passkey unlock unreadable; removed');
      return 'unreadable';
    }
    try {
      return new Uint8Array(innerOpen(innerKey(prf, row.salt), inner, aad));
    } catch {
      return 'wrong_secret';
    }
  }

  touch(credentialId: string): void {
    this.db.prepare('UPDATE passkey_unlocks SET last_used_at = ? WHERE credential_id = ?').run(this.now().toISOString(), credentialId);
  }

  remove(credentialId: string): boolean {
    return Number(this.db.prepare('DELETE FROM passkey_unlocks WHERE credential_id = ?').run(credentialId).changes) > 0;
  }

  /** How many were removed. */
  removeAll(): number {
    return Number(this.db.prepare('DELETE FROM passkey_unlocks').run().changes);
  }

  private openLabel(credentialId: string, sealed: Uint8Array): string {
    try {
      return this.cipher.open(sealed, labelAad(credentialId)).toString('utf8');
    } catch {
      logger.warn({ credential: shortId(credentialId) }, 'passkey label unreadable');
      return 'Passkey';
    }
  }
}
