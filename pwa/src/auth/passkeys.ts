import type { PasskeyBegin, UnlockCredential } from '../api.js';

/**
 * The browser side of passkey unlock (passkey-unlock spec §3). Everything
 * WebAuthn lives here; components never touch navigator.credentials. All
 * values that cross to the server are base64url. Nothing is verified here or
 * on the server: the PRF output is the secret, and the server's GCM tag is
 * the check (spec, Decisions).
 */

export type EnrolResult =
  | { kind: 'ok'; credentialId: string; prf: string }
  | { kind: 'cancelled' }
  /** The authenticator already holds one of the excluded passkeys. */
  | { kind: 'already_added' }
  /** Created, but it gives no PRF output, so it can't unlock. */
  | { kind: 'prf_unsupported'; credentialId: string }
  /** Safari refused the follow-up prompt without a new tap: run `finish` from a button. */
  | { kind: 'finish_setup'; credentialId: string; finish: () => Promise<EnrolResult> }
  /**
   * WebAuthn failed (`webauthn_<DOMException name>`). `credentialId`: the
   * follow-up prompt failed after creation, so a passkey exists that can't unlock.
   */
  | { kind: 'failed'; code: string; credentialId?: string };

export type UnlockResult =
  | { kind: 'ok'; credentialId: string; prf: string }
  | { kind: 'cancelled' }
  | { kind: 'no_prf' }
  /** `webauthn_<DOMException name>`. */
  | { kind: 'failed'; code: string };

const RP_NAME = 'Doc Scanner';
// ES256 and RS256: what platform authenticators and password managers offer.
const ALGORITHMS: PublicKeyCredentialParameters[] = [
  { type: 'public-key', alg: -7 },
  { type: 'public-key', alg: -257 },
];

export function toBase64url(data: BufferSource): string {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Required by WebAuthn; unused here, since no signature is checked. */
const challenge = () => crypto.getRandomValues(new Uint8Array(32));

const descriptor = (credentialId: string): PublicKeyCredentialDescriptor => ({ type: 'public-key', id: fromBase64url(credentialId) });

function errorName(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'name' in e && typeof e.name === 'string' ? e.name : undefined;
}

/** A WebAuthn failure other than the ones mapped by name: its code, or the error itself for anything that isn't a DOMException. */
function webauthnCode(e: unknown): string {
  if (e instanceof DOMException) return `webauthn_${e.name}`;
  throw e;
}

function asPublicKey(c: Credential | null): PublicKeyCredential | null {
  return c !== null && c.type === 'public-key' && 'getClientExtensionResults' in c ? (c as PublicKeyCredential) : null;
}

function prfOf(c: PublicKeyCredential): string | null {
  const first = c.getClientExtensionResults().prf?.results?.first;
  return first ? toBase64url(first) : null;
}

/**
 * Creates a discoverable, user-verified passkey and reads its PRF output for
 * the server's salt. An authenticator that gives no PRF result at creation is
 * asked again with an assertion (spec §2, Enrolment).
 */
export async function enrolPasskey(begin: PasskeyBegin, email: string): Promise<EnrolResult> {
  const salt = fromBase64url(begin.salt);
  let created: PublicKeyCredential | null;
  try {
    created = asPublicKey(
      await navigator.credentials.create({
        publicKey: {
          rp: { name: RP_NAME },
          user: { id: fromBase64url(begin.userHandle), name: email, displayName: email },
          challenge: challenge(),
          pubKeyCredParams: ALGORITHMS,
          excludeCredentials: begin.excludeCredentials.map(descriptor),
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          extensions: { prf: { eval: { first: salt } } },
        },
      }),
    );
  } catch (e) {
    const name = errorName(e);
    // AbortError: the page or the browser stopped the prompt; nothing was made.
    if (name === 'NotAllowedError' || name === 'AbortError') return { kind: 'cancelled' };
    if (name === 'InvalidStateError') return { kind: 'already_added' };
    return { kind: 'failed', code: webauthnCode(e) };
  }
  if (!created) return { kind: 'cancelled' };
  const prf = prfOf(created);
  if (prf) return { kind: 'ok', credentialId: created.id, prf };
  // The authenticator said it has no PRF: a second prompt would only ask for nothing.
  if (created.getClientExtensionResults().prf?.enabled === false) return { kind: 'prf_unsupported', credentialId: created.id };
  return readPrf(created.id, salt);
}

/** The follow-up assertion at enrolment, for a PRF result creation didn't give. */
async function readPrf(credentialId: string, salt: Uint8Array<ArrayBuffer>): Promise<EnrolResult> {
  let got: PublicKeyCredential | null;
  try {
    got = asPublicKey(
      await navigator.credentials.get({
        publicKey: {
          challenge: challenge(),
          allowCredentials: [descriptor(credentialId)],
          userVerification: 'required',
          extensions: { prf: { eval: { first: salt } } },
        },
      }),
    );
  } catch (e) {
    // Safari may refuse a second prompt without a fresh tap; a tap on Finish setup asks again.
    if (errorName(e) === 'NotAllowedError') return { kind: 'finish_setup', credentialId, finish: () => readPrf(credentialId, salt) };
    // The passkey exists, so the caller can ask the password manager to hide it.
    return { kind: 'failed', code: e instanceof DOMException ? `webauthn_${e.name}` : 'error', credentialId };
  }
  const prf = got ? prfOf(got) : null;
  return prf ? { kind: 'ok', credentialId, prf } : { kind: 'prf_unsupported', credentialId };
}

/** One prompt for any enrolled passkey; each gets its own salt, keyed by its id (spec §2, Unlock). */
export async function unlockWithPasskey(credentials: UnlockCredential[]): Promise<UnlockResult> {
  const evalByCredential: Record<string, AuthenticationExtensionsPRFValues> = {};
  for (const c of credentials) evalByCredential[c.credentialId] = { first: fromBase64url(c.salt) };
  let got: PublicKeyCredential | null;
  try {
    got = asPublicKey(
      await navigator.credentials.get({
        publicKey: {
          challenge: challenge(),
          allowCredentials: credentials.map((c) => descriptor(c.credentialId)),
          userVerification: 'required',
          extensions: { prf: { evalByCredential } },
        },
      }),
    );
  } catch (e) {
    const name = errorName(e);
    if (name === 'NotAllowedError' || name === 'AbortError') return { kind: 'cancelled' };
    return { kind: 'failed', code: webauthnCode(e) };
  }
  if (!got) return { kind: 'cancelled' };
  const prf = prfOf(got);
  return prf ? { kind: 'ok', credentialId: got.id, prf } : { kind: 'no_prf' };
}

/**
 * Asks the password manager to hide a passkey the server never stored. True
 * when the browser took the signal; otherwise the user is told it can be
 * deleted there.
 */
export async function forgetCredential(credentialId: string): Promise<boolean> {
  const pkc = (globalThis as unknown as { PublicKeyCredential?: { signalUnknownCredential?: (o: UnknownCredentialOptions) => Promise<void> } })
    .PublicKeyCredential;
  if (typeof pkc?.signalUnknownCredential !== 'function') return false;
  try {
    await pkc.signalUnknownCredential({ rpId: location.hostname, credentialId });
    return true;
  } catch {
    return false;
  }
}
