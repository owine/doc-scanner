import { vi, type Mock } from 'vitest';
import { toBase64url } from '../../src/auth/passkeys.js';

export interface FakeCredentialOptions {
  /** `prf.enabled`, as `create` reports it; left out, as `get` leaves it out. */
  enabled?: boolean;
}

/**
 * A credential as navigator.credentials returns it: only what passkeys.ts
 * reads. `prf: null` gives no PRF result. The result is an ArrayBuffer, as
 * real browsers give it.
 */
export function fakeCredential(id: string, prf: Uint8Array | null, { enabled }: FakeCredentialOptions = {}): PublicKeyCredential {
  const out: AuthenticationExtensionsPRFOutputs = {};
  if (enabled !== undefined) out.enabled = enabled;
  if (prf) out.results = { first: new Uint8Array(prf).buffer };
  const results: AuthenticationExtensionsClientOutputs = { prf: out };
  return { id, type: 'public-key', getClientExtensionResults: () => results } as unknown as PublicKeyCredential;
}

/** Loosely typed, so tests can read the options they were called with. */
type FakeMethod = Mock<(options: any) => Promise<unknown>>;

export interface FakeCredentials {
  create: FakeMethod;
  get: FakeMethod;
}

/**
 * Puts fakes on navigator.credentials. Undo with removeCredentials(). `get`
 * refuses, as browsers do, a PRF `evalByCredential` key that isn't in
 * `allowCredentials` (SyntaxError), before the fake is called.
 */
export function installCredentials(): FakeCredentials {
  const fake: FakeCredentials = { create: vi.fn(), get: vi.fn() };
  const credentials = {
    create: (options: CredentialCreationOptions) => fake.create(options),
    get: (options: CredentialRequestOptions) => {
      const publicKey = options.publicKey;
      const evalByCredential = publicKey?.extensions?.prf?.evalByCredential;
      if (evalByCredential) {
        const allowed = new Set((publicKey?.allowCredentials ?? []).map((d) => toBase64url(d.id)));
        if (Object.keys(evalByCredential).some((id) => !allowed.has(id))) return Promise.reject(domError('SyntaxError'));
      }
      return fake.get(options);
    },
  };
  Object.defineProperty(navigator, 'credentials', { value: credentials, configurable: true });
  return fake;
}

export function removeCredentials(): void {
  Reflect.deleteProperty(navigator, 'credentials');
}

/** WebAuthn fails with DOMExceptions named for the cause. */
export const domError = (name: string) => new DOMException(`${name} from the authenticator`, name);
