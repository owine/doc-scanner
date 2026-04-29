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

export function registerLiveSession(s: LiveSession): void {
  sessions.set(s.sid, s);
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
