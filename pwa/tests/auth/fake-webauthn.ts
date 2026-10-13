import { vi } from 'vitest';

/** A credential as navigator.credentials returns it: only what passkeys.ts reads. `prf: null` gives no PRF result. */
export function fakeCredential(id: string, prf: Uint8Array | null): PublicKeyCredential {
  const results: AuthenticationExtensionsClientOutputs = prf ? { prf: { results: { first: new Uint8Array(prf) } } } : { prf: {} };
  return { id, type: 'public-key', getClientExtensionResults: () => results } as unknown as PublicKeyCredential;
}

export interface FakeCredentials {
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

/** Puts fakes on navigator.credentials. Undo with removeCredentials(). */
export function installCredentials(): FakeCredentials {
  const fake: FakeCredentials = { create: vi.fn(), get: vi.fn() };
  Object.defineProperty(navigator, 'credentials', { value: fake, configurable: true });
  return fake;
}

export function removeCredentials(): void {
  Reflect.deleteProperty(navigator, 'credentials');
}

/** WebAuthn fails with DOMExceptions named for the cause. */
export const domError = (name: string) => new DOMException(`${name} from the authenticator`, name);
