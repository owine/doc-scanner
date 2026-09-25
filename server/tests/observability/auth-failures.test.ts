import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushEvents, initRecordingSentry } from '../helpers/sentry-transport.js';
import { ProtonApiError, type ProtonApi } from '../../src/auth/proton-api.js';

// Skip the SRP maths: login's later stages are what we need to reach, and the
// real proof is covered by the integration test against a live account.
vi.mock('../../src/vendor/proton-srp/srp.js', () => ({
  getSrp: vi.fn().mockResolvedValue({ clientEphemeral: 'ce', clientProof: 'cp', expectedServerProof: 'sp' }),
}));

const { ProtonAuth, TwoFactorRequiredError } = await import('../../src/auth/srp.js');

const { events } = initRecordingSentry();

// Runtime-built so they never appear in this file's source (ContextLines).
const accessToken = `AT-${Math.random().toString(36).slice(2)}`;
const refreshToken = `RT-${Math.random().toString(36).slice(2)}`;
const typedSecret = `PW-${Math.random().toString(36).slice(2)}`;

const AUTH_INFO = { Version: 4, Modulus: 'm', ServerEphemeral: 'se', Salt: 's', SRPSession: 'srp' };

function fakeApi(overrides: Partial<Record<keyof ProtonApi, unknown>> = {}): ProtonApi {
  return {
    getAuthInfo: vi.fn().mockResolvedValue(AUTH_INFO),
    submitAuth: vi.fn().mockResolvedValue({ UID: 'uid-1', AccessToken: accessToken, RefreshToken: refreshToken }),
    submit2FA: vi.fn().mockResolvedValue({ Code: 1000 }),
    getKeySalts: vi.fn().mockResolvedValue({ KeySalts: [] }),
    getUser: vi.fn().mockResolvedValue({ User: { Keys: [] } }),
    getAddresses: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  } as unknown as ProtonApi;
}

function tagsOf(index: number): Record<string, unknown> | undefined {
  return events[index]?.tags as Record<string, unknown> | undefined;
}

describe('login failure reporting', () => {
  beforeEach(() => { events.length = 0; });

  it('does not report a wrong password (Proton code 8002)', async () => {
    const api = fakeApi({
      submitAuth: vi.fn().mockRejectedValue(new ProtonApiError('Incorrect login credentials', 422, 8002)),
    });

    await expect(new ProtonAuth(api).login('me@example.test', typedSecret)).rejects.toThrow();
    await flushEvents();

    expect(events).toHaveLength(0);
  });

  it('does not report a missing TOTP code', async () => {
    const api = fakeApi({
      submitAuth: vi.fn().mockResolvedValue({ UID: 'u', AccessToken: accessToken, RefreshToken: refreshToken, '2FA': { Enabled: 1 } }),
    });

    await expect(new ProtonAuth(api).login('me@example.test', typedSecret)).rejects.toBeInstanceOf(TwoFactorRequiredError);
    await flushEvents();

    expect(events).toHaveLength(0);
  });

  it('does not report a rejected TOTP code', async () => {
    const api = fakeApi({
      submitAuth: vi.fn().mockResolvedValue({ UID: 'u', AccessToken: accessToken, RefreshToken: refreshToken, '2FA': { Enabled: 1 } }),
      submit2FA: vi.fn().mockRejectedValue(new ProtonApiError('Incorrect code', 401)),
    });

    await expect(new ProtonAuth(api).login('me@example.test', typedSecret, '123456')).rejects.toThrow();
    await flushEvents();

    expect(events).toHaveLength(0);
  });

  it('reports a Proton outage during login, tagged with operation and stage', async () => {
    const api = fakeApi({ getAuthInfo: vi.fn().mockRejectedValue(new ProtonApiError('HTTP 503', 503)) });

    await expect(new ProtonAuth(api).login('me@example.test', typedSecret)).rejects.toThrow();
    await flushEvents();

    expect(events).toHaveLength(1);
    expect(tagsOf(0)).toMatchObject({ 'auth.operation': 'login', 'auth.stage': 'info' });
  });

  it('reports a key setup failure tagged keys (auth-response tokens are not attached)', async () => {
    const api = fakeApi();

    await expect(new ProtonAuth(api).login('me@example.test', typedSecret)).rejects.toThrow(/no primary active key/);
    await flushEvents();

    expect(events).toHaveLength(1);
    expect(tagsOf(0)).toMatchObject({ 'auth.operation': 'login', 'auth.stage': 'keys' });
    const wire = JSON.stringify(events[0]);
    for (const value of [accessToken, refreshToken, typedSecret]) expect(wire).not.toContain(value);
  });

  it('reports a key failure whose message names the address, without sending the address', async () => {
    const address = `${Math.random().toString(36).slice(2)}@proton.example`;
    const api = fakeApi({ getUser: vi.fn().mockRejectedValue(new Error(`no active keys for ${address}`)) });

    await expect(new ProtonAuth(api).login('me@example.test', typedSecret)).rejects.toThrow();
    await flushEvents();

    expect(events).toHaveLength(1);
    expect(events[0]?.exception?.values?.[0]?.value).toBe('no active keys for [email]');
    expect(JSON.stringify(events[0])).not.toContain(address);
  });

  it('reports rate limiting, which is not a user typo', async () => {
    const api = fakeApi({ submitAuth: vi.fn().mockRejectedValue(new ProtonApiError('Too many requests', 429, 2028)) });

    await expect(new ProtonAuth(api).login('me@example.test', typedSecret)).rejects.toThrow();
    await flushEvents();

    expect(events).toHaveLength(1);
    expect(tagsOf(0)).toMatchObject({ 'auth.stage': 'srp' });
  });
});
