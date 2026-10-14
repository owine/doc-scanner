import { api, ApiError, type PasskeyBegin, type PasskeyEntry, type PasskeyList, type StatusResponse, type UnlockCredential } from '../api.js';
import { enrolPasskey, forgetCredential, unlockWithPasskey, type EnrolResult } from './passkeys.js';

/**
 * Unlock and enrolment as the screens use them: the WebAuthn prompt
 * (passkeys.ts) joined to the server calls, with every outcome typed.
 *
 * Both take what they need from the server up front when they can (the
 * `prepared` and `begin` arguments). WebKit may require the passkey prompt to
 * start straight from the tap, so the screens fetch first, before the tap.
 */

export type UnlockOutcome =
  | { kind: 'unlocked'; status: StatusResponse }
  | { kind: 'cancelled' }
  /** `code`: the server's error, `request_failed` for an answer without one, `error` for anything else. */
  | { kind: 'failed'; code: string };

export type EnrolOutcome =
  | { kind: 'added'; passkey: PasskeyEntry }
  | { kind: 'cancelled' }
  | { kind: 'already_added' }
  /** `forgotten`: the password manager was asked to hide the passkey that can't unlock. */
  | { kind: 'prf_unsupported'; forgotten: boolean }
  /** The server lost the salt (5 minutes, or a restart); the passkey exists but was never stored. */
  | { kind: 'expired'; forgotten: boolean }
  /** `abandon`: the user walked away, so ask the password manager to hide the half-made passkey. */
  | { kind: 'finish_setup'; finish: () => Promise<EnrolOutcome>; abandon: () => Promise<boolean> }
  /** `forgotten`: set when the server refused a created passkey, as for `prf_unsupported`. */
  | { kind: 'failed'; code: string; forgotten?: boolean };

const codeOf = (e: unknown): string => (e instanceof ApiError ? (e.code ?? 'request_failed') : 'error');
const failed = (e: unknown): EnrolOutcome => ({ kind: 'failed', code: codeOf(e) });

/** One tap: the passkey prompt, then the server unwraps and resumes Proton (spec §2, Unlock). */
export async function unlock(prepared: UnlockCredential[] | null = null): Promise<UnlockOutcome> {
  try {
    // With salts in hand, the prompt starts before any await, inside the tap.
    const credentials = prepared && prepared.length > 0 ? prepared : (await api.unlock.begin()).credentials;
    const result = await unlockWithPasskey(credentials);
    if (result.kind === 'cancelled') return { kind: 'cancelled' };
    if (result.kind === 'no_prf') return { kind: 'failed', code: 'unlock_failed' };
    if (result.kind === 'failed') return { kind: 'failed', code: result.code };
    try {
      return { kind: 'unlocked', status: await api.unlock({ credentialId: result.credentialId, prf: result.prf }) };
    } catch (e) {
      // The server has no such passkey (removed elsewhere): ask the password manager to hide it.
      if (e instanceof ApiError && e.code === 'unknown_passkey') await forgetCredential(result.credentialId);
      throw e;
    }
  } catch (e) {
    return { kind: 'failed', code: codeOf(e) };
  }
}

/** Spec §2, Enrolment: begin (unless given), the passkey prompt, then the server wraps the passphrase. */
export async function enrol(label: string, email: string, begin?: PasskeyBegin): Promise<EnrolOutcome> {
  try {
    const started = begin ?? (await api.passkeys.begin());
    return await settle(await enrolPasskey(started, email), started.salt, label);
  } catch (e) {
    return failed(e);
  }
}

async function settle(result: EnrolResult, salt: string, label: string): Promise<EnrolOutcome> {
  switch (result.kind) {
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'already_added':
      return { kind: 'already_added' };
    case 'prf_unsupported':
      // Created, but it can't unlock: nothing goes to the server.
      return { kind: 'prf_unsupported', forgotten: await forgetCredential(result.credentialId) };
    case 'failed':
      // A passkey made before the follow-up prompt failed can't unlock: hide it.
      return result.credentialId === undefined
        ? { kind: 'failed', code: result.code }
        : { kind: 'failed', code: result.code, forgotten: await forgetCredential(result.credentialId) };
    case 'finish_setup': {
      const { finish, credentialId } = result;
      return {
        kind: 'finish_setup',
        finish: async () => {
          try {
            return await settle(await finish(), salt, label);
          } catch (e) {
            return failed(e);
          }
        },
        abandon: () => forgetCredential(credentialId),
      };
    }
    case 'ok':
      try {
        return { kind: 'added', passkey: await api.passkeys.add({ credentialId: result.credentialId, salt, prf: result.prf, label }) };
      } catch (e) {
        // Only a refusal (a 4xx with the server's code) means it wasn't stored.
        // No answer, a 5xx, or an answer without a code (a proxy's HTML 502)
        // may have come after the server stored it: keep that passkey.
        if (!(e instanceof ApiError && e.code !== undefined && e.status >= 400 && e.status < 500)) return failed(e);
        // The server refused it, so it will never unlock: ask the password manager to hide it.
        const forgotten = await forgetCredential(result.credentialId);
        if (e.code === 'invalid_enrolment') return { kind: 'expired', forgotten };
        return { kind: 'failed', code: codeOf(e), forgotten };
      }
  }
}

/** What the unlock banner calls; injectable for tests. */
export interface UnlockClient {
  /** Fetched before the tap: the salts for the prompt. */
  prepare: () => Promise<UnlockCredential[]>;
  unlock: (prepared: UnlockCredential[] | null) => Promise<UnlockOutcome>;
}

export const unlockClient: UnlockClient = {
  prepare: async () => (await api.unlock.begin()).credentials,
  unlock,
};

/** What Settings → Passkeys calls; injectable for tests. */
export interface PasskeysClient {
  list: () => Promise<PasskeyList>;
  remove: (credentialId: string) => Promise<unknown>;
  /** Fetched when Add passkey is tapped, before the prompt's own tap. */
  begin: () => Promise<PasskeyBegin>;
  enrol: (label: string, email: string, begin?: PasskeyBegin) => Promise<EnrolOutcome>;
}

export const passkeysClient: PasskeysClient = {
  list: () => api.passkeys.list(),
  remove: (credentialId) => api.passkeys.remove(credentialId),
  begin: () => api.passkeys.begin(),
  enrol,
};
