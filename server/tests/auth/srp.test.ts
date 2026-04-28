import { describe, it, expect, vi } from 'vitest';
import { ProtonAuth } from '../../src/auth/srp.js';
import type { ProtonApi, AuthInfo, AuthResponse } from '../../src/auth/proton-api.js';

function makeFakeApi(overrides: Partial<ProtonApi> = {}): ProtonApi {
  const base: any = {
    getAuthInfo: vi.fn<(u: string) => Promise<AuthInfo>>(),
    submitAuth: vi.fn<(b: any) => Promise<AuthResponse>>(),
    submit2FA: vi.fn(),
    refresh: vi.fn(),
  };
  return Object.assign(base, overrides) as ProtonApi;
}

describe('ProtonAuth.login', () => {
  it('throws AuthVersionError on AUTH_VERSION mismatch', async () => {
    const api = makeFakeApi({
      getAuthInfo: vi.fn().mockResolvedValue({ Version: 99, Modulus: '', ServerEphemeral: '', Salt: '', SRPSession: '' }),
    } as any);
    const auth = new ProtonAuth(api);
    await expect(auth.login('u@x.test', 'p')).rejects.toThrow(/auth version/i);
  });

  // NOTE: Full SRP happy-path is verified by the integration test against a real
  // Proton account. Unit testing valid SRP math would require fixture vectors we
  // don't have.
});
