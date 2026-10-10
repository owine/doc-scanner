import type { ProtonSession } from './srp.js';
import type { MailboxSecret } from './secrets/mailbox-password.js';
import type { DecryptedUserKey } from './keys.js';
import type { DriveClient } from '../drive/client.js';

export interface LiveSession {
  sid: string;
  session: ProtonSession;
  mailboxSecret: MailboxSecret;
  decryptedKeys: DecryptedUserKey;
  driveClient: DriveClient;
}

const sessions = new Map<string, LiveSession>();

const listeners = new Set<(s: LiveSession) => void>();

/** Called after every login; returns an unsubscribe function. */
export function onLiveSessionRegistered(fn: (s: LiveSession) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The current live session, for work that runs outside a request (the
 * document worker). Single-user: the most recent login wins.
 */
export function getAnyLiveSession(): LiveSession | undefined {
  let last: LiveSession | undefined;
  for (const s of sessions.values()) last = s;
  return last;
}

export function registerLiveSession(s: LiveSession): void {
  // Re-insert so iteration order tracks recency.
  sessions.delete(s.sid);
  sessions.set(s.sid, s);
  for (const fn of listeners) {
    try {
      fn(s);
    } catch {
      // A listener's failure is its own problem; login must still succeed.
    }
  }
}

export function getLiveSession(sid: string): LiveSession | undefined {
  return sessions.get(sid);
}

export function disposeLiveSession(sid: string): void {
  const s = sessions.get(sid);
  s?.mailboxSecret.dispose();
  sessions.delete(sid);
}

// For tests: clear all live sessions between tests
export function _resetLiveSessions(): void {
  for (const sid of sessions.keys()) disposeLiveSession(sid);
}
