import { vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as openpgp from 'openpgp';
import { createApp } from '../../src/http/server.js';
import { createTestDb } from './test-db.js';
import { SessionStore } from '../../src/auth/session-store.js';
import { PasskeyStore } from '../../src/auth/passkey-store.js';
import { AtRestCipher } from '../../src/crypto/at-rest.js';
import { MailboxSecret } from '../../src/auth/secrets/mailbox-password.js';
import type { AuthMode } from '../../src/http/middleware.js';
import { createPipeline, type Pipeline } from '../../src/documents/pipeline.js';
import { fakePrepare } from '../documents/harness.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import type { LoginResult, ProtonAuth, ProtonSession, ResumeResult } from '../../src/auth/srp.js';
import type { DB } from '../../src/db.js';

export const KEY = Buffer.alloc(32, 1).toString('base64');
export const PROXY_USER = 'owine';
export const PROXY_HEADERS: Record<string, string> = { 'Remote-User': PROXY_USER };
export const HEADER_MODE: AuthMode = { kind: 'header', user: PROXY_USER, secret: null };
export const SESSION: ProtonSession = { uid: 'u', accessToken: 'a', refreshToken: 'r', email: 'e@x.test' };
export const PASSPHRASE = 'mailbox-passphrase-Northwind';

/** A passkey as the tests enrol it: the PRF output is never stored, so the tests keep it. */
export const CRED = 'cred-AAAAAAAAAAAAAAAA';
export const CRED_2 = 'cred-BBBBBBBBBBBBBBBB';
export const PRF = new Uint8Array(32).fill(7);
export const PRF_B64 = Buffer.from(PRF).toString('base64url');
export const SALT = new Uint8Array(32).fill(3);
export const LABEL = 'Northwind phone';

/** Real, decrypted keys: DriveClient's constructor reads them. */
export async function makeKeys(): Promise<DecryptedUserKey> {
  const { privateKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'e@x.test' }], passphrase: 'p', format: 'object',
  });
  const key = await openpgp.decryptKey({ privateKey, passphrase: 'p' });
  return {
    primaryAddress: { email: 'e@x.test', addressId: 'a1' },
    primaryKey: key,
    addresses: [{ email: 'e@x.test', addressId: 'a1', keys: [{ id: 'k1', key }], primaryKeyIndex: 0 }],
  };
}

export function loginResult(keys: DecryptedUserKey, over: Partial<LoginResult> = {}): LoginResult {
  return {
    session: { ...SESSION },
    mailboxSecret: new MailboxSecret(new TextEncoder().encode(PASSPHRASE)),
    decryptedKeys: keys,
    userId: 'user-1',
    keySaltFingerprint: 'fp-1',
    ...over,
  };
}

export function resumeResult(keys: DecryptedUserKey, over: Partial<ResumeResult> = {}): ResumeResult {
  return { session: { ...SESSION }, decryptedKeys: keys, userId: 'user-1', ...over };
}

export interface FakeAuth {
  login: Mock;
  refresh: Mock;
  resume: Mock;
}

export interface AuthApp {
  app: ReturnType<typeof createApp>;
  db: DB;
  auth: FakeAuth;
  store: SessionStore;
  passkeys: PasskeyStore;
  pipeline: Pipeline | undefined;
  cleanup: () => void;
}

/**
 * An app with a fake ProtonAuth, in header mode unless told otherwise. With
 * `pipeline`, a document pipeline that is not started (tests start it). With
 * `db`, a second app on an existing database: a server restart.
 */
export function authApp(opts: { mode?: AuthMode; pipeline?: boolean; db?: DB } = {}): AuthApp {
  const cleanups: (() => void)[] = [];
  let db = opts.db;
  if (!db) {
    const t = createTestDb();
    db = t.db;
    cleanups.push(t.cleanup);
  }
  let pipeline: Pipeline | undefined;
  if (opts.pipeline) {
    const dir = mkdtempSync(join(tmpdir(), 'auth-app-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    pipeline = createPipeline({
      db,
      dataDir: dir,
      encryptionKey: KEY,
      defaults: { model: 'm', effort: 'medium', autoFileThreshold: 0.8, autoFileEnabled: false, excludePaths: [] },
      analyzerFor: () => ({ analyze: vi.fn() }),
      liveSession: () => undefined,
      prepare: fakePrepare(),
    });
  }
  const auth: FakeAuth = { login: vi.fn(), refresh: vi.fn(), resume: vi.fn() };
  const app = createApp({
    db,
    encryptionKey: KEY,
    protonAuth: auth as unknown as ProtonAuth,
    authMode: opts.mode ?? HEADER_MODE,
    pipeline,
  });
  return {
    app,
    db,
    auth,
    store: new SessionStore(db, KEY),
    passkeys: new PasskeyStore(db, new AtRestCipher(KEY, 'passkeys')),
    pipeline,
    cleanup: () => {
      pipeline?.stop();
      for (const c of cleanups) c();
    },
  };
}

export function post(app: AuthApp['app'], path: string, body?: unknown, headers: Record<string, string> = PROXY_HEADERS) {
  return app.request(path, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function get(app: AuthApp['app'], path: string, headers: Record<string, string> = PROXY_HEADERS) {
  return app.request(path, { headers });
}

export function del(app: AuthApp['app'], path: string, headers: Record<string, string> = PROXY_HEADERS) {
  return app.request(path, { method: 'DELETE', headers });
}

/** Signs in to Proton through the route, so a live session exists. */
export async function signIn(ctx: AuthApp, keys: DecryptedUserKey, over: Partial<LoginResult> = {}, email = 'e@x.test') {
  ctx.auth.login.mockResolvedValueOnce(loginResult(keys, over));
  const res = await post(ctx.app, '/api/auth/login', { email, password: 'p' });
  if (res.status !== 200) throw new Error(`login answered ${res.status}`);
}

export function seedPasskey(passkeys: PasskeyStore, credentialId = CRED, prf: Uint8Array = PRF): void {
  passkeys.add({ credentialId, label: LABEL, salt: SALT, prf, passphrase: new TextEncoder().encode(PASSPHRASE) });
}
