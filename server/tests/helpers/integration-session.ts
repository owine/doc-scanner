import { ProtonApi } from '../../src/auth/proton-api.js';
import { ProtonAuth } from '../../src/auth/srp.js';
import type { DecryptedUserKey } from '../../src/auth/keys.js';
import type { ProtonSession } from '../../src/auth/srp.js';
import type { MailboxSecret } from '../../src/auth/secrets/mailbox-password.js';

/**
 * Shared login for the integration test suite.
 *
 * Each successful SRP exchange against Proton costs bcrypt rounds + a real
 * API round-trip, and counts against Proton's "recent logins" anti-abuse
 * budget. We do ONE login per vitest run and let all integration tests
 * reuse the same session.
 *
 * Vitest runs each test file in its own process by default. To make the
 * cache file-process-local works only if all integration tests live in one
 * file. Across files, this still de-duplicates within the file.
 *
 * For across-file sharing, we use a process-singleton via a Symbol.for key
 * so it survives module reloads under vitest's isolate mode but stays
 * scoped to this process.
 */

const KEY = Symbol.for('doc-scanner.integration.session');

interface SharedSession {
  api: ProtonApi;
  auth: ProtonAuth;
  session: ProtonSession;
  decryptedKeys: DecryptedUserKey;
  mailboxSecret: MailboxSecret;
}

interface Cache {
  promise?: Promise<SharedSession>;
}

function cache(): Cache {
  const g = globalThis as unknown as Record<symbol, Cache>;
  if (!g[KEY]) g[KEY] = {};
  return g[KEY];
}

export async function getSharedSession(): Promise<SharedSession> {
  const c = cache();
  if (c.promise) return c.promise;

  const email = process.env.PROTON_TEST_EMAIL;
  const password = process.env.PROTON_TEST_PASSWORD;
  if (!email || !password) {
    throw new Error('Set PROTON_TEST_EMAIL and PROTON_TEST_PASSWORD');
  }

  const api = new ProtonApi('https://mail.proton.me/api', 'external-drive-docscanner@0.1.0');
  const auth = new ProtonAuth(api);

  c.promise = auth.login(email, password).then((result) => ({
    api,
    auth,
    session: result.session,
    decryptedKeys: result.decryptedKeys,
    mailboxSecret: result.mailboxSecret,
  }));

  return c.promise;
}

/** Releases the cached session. Call from the last integration test if you want explicit cleanup. */
export function disposeSharedSession(): void {
  const c = cache();
  if (!c.promise) return;
  void c.promise.then((s) => s.mailboxSecret.dispose()).catch(() => {});
  c.promise = undefined;
}
