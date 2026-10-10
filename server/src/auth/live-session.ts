import type { ProtonSession } from './srp.js';
import type { MailboxSecret } from './secrets/mailbox-password.js';
import type { DecryptedUserKey } from './keys.js';
import type { DriveClient } from '../drive/client.js';
import { logger } from '../logger.js';

export interface LiveSession {
  sid: string;
  session: ProtonSession;
  mailboxSecret: MailboxSecret;
  decryptedKeys: DecryptedUserKey;
  driveClient: DriveClient;
}

const sessions = new Map<string, LiveSession>();

const listeners = new Set<(s: LiveSession) => void | Promise<unknown>>();

/** Called after every login; returns an unsubscribe function. */
export function onLiveSessionRegistered(fn: (s: LiveSession) => void | Promise<unknown>): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The current live session, for work that runs outside a request (the
 * document worker). Single-user: the most recent login that is still live;
 * logout disposes all of them.
 */
export function getAnyLiveSession(): LiveSession | undefined {
  let last: LiveSession | undefined;
  for (const s of sessions.values()) last = s;
  return last;
}

export function registerLiveSession(s: LiveSession): void {
  const existing = sessions.get(s.sid);
  if (existing && existing !== s) existing.mailboxSecret.dispose();
  // Re-insert so iteration order tracks recency.
  sessions.delete(s.sid);
  sessions.set(s.sid, s);
  // Listeners run off the login path; a failure (sync or async) is logged and
  // never breaks login or other listeners.
  for (const fn of listeners) {
    void Promise.resolve()
      .then(() => fn(s))
      .catch((err) => logger.warn({ err }, 'live-session listener failed'));
  }
}

export function getLiveSession(sid: string): LiveSession | undefined {
  return sessions.get(sid);
}

/** Logout: dispose every live session. */
export function disposeAllLiveSessions(): void {
  for (const s of sessions.values()) s.mailboxSecret.dispose();
  sessions.clear();
}

// For tests: clear all live sessions between tests
export function _resetLiveSessions(): void {
  disposeAllLiveSessions();
}
