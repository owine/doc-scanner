import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { DB } from '../db.js';
import type { SessionStore } from '../auth/session-store.js';
import { CREDENTIAL_ID, PRF_BYTES, decodeBase64url, shortId, type PasskeyEntry, type PasskeyStore } from '../auth/passkey-store.js';
import { SETTING, readSetting, takeSetting, writeSetting } from '../auth/app-settings.js';
import { logger } from '../logger.js';
import { PROXY_SID, headerOnly, sessionMiddleware, smallBodies, type AuthContext, type AuthMode } from './middleware.js';
import { getLiveSession } from '../auth/live-session.js';

type Env = { Variables: { auth?: AuthContext } };

/** How long a salt from /begin can be used. */
const PENDING_MS = 5 * 60 * 1000;
/** Enough for any real enrolment; bounds the map against a client calling /begin in a loop. */
const MAX_PENDING = 16;
const MAX_LABEL_CHARS = 60;

const AddSchema = z
  .object({
    credentialId: z.string().regex(CREDENTIAL_ID),
    salt: z.string().min(1).max(100),
    prf: z.string().min(1).max(100),
    label: z.string().max(1000).optional(),
  })
  .strict();

/** The WebAuthn user handle: random, made once, so every passkey belongs to one user. */
function userHandle(db: DB): string {
  const existing = readSetting(db, SETTING.userHandle);
  if (existing !== null) return existing;
  const made = randomBytes(16).toString('base64url');
  writeSetting(db, SETTING.userHandle, made);
  return made;
}

/** Trimmed and capped in characters (not UTF-16 units); an empty label becomes "Passkey". */
function cleanLabel(label: string | undefined): string {
  return [...(label ?? '').trim()].slice(0, MAX_LABEL_CHARS).join('').trim() || 'Passkey';
}

/** Passkey enrolment, listing and removal (passkey-unlock spec §2). Header mode only. */
export function passkeyRoutes(deps: { db: DB; store: SessionStore; passkeys: PasskeyStore; authMode: AuthMode }) {
  const r = new Hono<Env>();
  r.use('*', smallBodies(), sessionMiddleware(deps.store, deps.authMode), headerOnly(deps.authMode));
  // Salt (base64url) -> when it expires. In memory: a restart ends every enrolment under way.
  const pending = new Map<string, number>();
  const prune = (now: number) => {
    for (const [salt, expires] of pending) if (expires <= now) pending.delete(salt);
  };

  r.post('/begin', (c) => {
    // The server wraps the passphrase the live session holds.
    if (!c.get('auth')!.liveSession) return c.json({ error: 'proton_not_live' }, 409);
    const now = Date.now();
    prune(now);
    const salt = randomBytes(PRF_BYTES).toString('base64url');
    // A Map iterates in insertion order: the first key is the oldest.
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
    pending.set(salt, now + PENDING_MS);
    return c.json({
      salt,
      userHandle: userHandle(deps.db),
      excludeCredentials: deps.passkeys.saltsFor().map((p) => p.credentialId),
    });
  });

  r.post('/', async (c) => {
    const live = c.get('auth')!.liveSession;
    if (!live) return c.json({ error: 'proton_not_live' }, 409);
    const body = AddSchema.safeParse(await c.req.json().catch(() => null));
    // A logout or another login may have run while the body arrived: the
    // captured session's passphrase is disposed. No await from here to use().
    if (getLiveSession(PROXY_SID) !== live) return c.json({ error: 'proton_not_live' }, 409);
    if (!body.success) return c.json({ error: 'invalid_input' }, 400);
    const { credentialId, salt, label } = body.data;
    prune(Date.now());
    // Unknown, expired, already used, or lost to a restart.
    if (!pending.has(salt)) return c.json({ error: 'invalid_enrolment' }, 400);
    const prf = decodeBase64url(body.data.prf);
    if (!prf || prf.length !== PRF_BYTES) return c.json({ error: 'invalid_input' }, 400);
    // add() would replace the wrap: a second enrolment of one authenticator
    // must not silently overwrite the first (begin excludes known ids).
    if (deps.passkeys.has(credentialId)) {
      prf.fill(0);
      return c.json({ error: 'already_enrolled' }, 409);
    }
    let entry: PasskeyEntry;
    try {
      entry = await live.mailboxSecret.use((passphrase) =>
        // The salt is one this server made, so it decodes.
        deps.passkeys.add({ credentialId, label: cleanLabel(label), salt: decodeBase64url(salt)!, prf, passphrase }),
      );
    } finally {
      prf.fill(0);
    }
    pending.delete(salt);
    // What a later password login compares, to tell the password changed (spec §2).
    // An unlocked session with none known leaves the recorded one in place.
    if (live.keySaltFingerprint !== null) writeSetting(deps.db, SETTING.keySaltFingerprint, live.keySaltFingerprint);
    logger.info({ credential: shortId(credentialId) }, 'passkey added');
    return c.json(entry, 201);
  });

  r.get('/', (c) => {
    // Said once: Settings reads the list when it opens.
    const notice = takeSetting(deps.db, SETTING.removedNotice) === 'password_changed' ? 'password_changed' : null;
    return c.json({ passkeys: deps.passkeys.list(), notice });
  });

  r.delete('/:credentialId', (c) => {
    const credentialId = c.req.param('credentialId');
    if (!CREDENTIAL_ID.test(credentialId) || !deps.passkeys.remove(credentialId)) return c.json({ error: 'not_found' }, 404);
    logger.info({ credential: shortId(credentialId) }, 'passkey removed');
    return c.body(null, 204);
  });

  return r;
}
