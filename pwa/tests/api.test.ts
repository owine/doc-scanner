import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../src/api.js';

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(body: unknown, status = 200) {
  // A fresh Response per call: a body can only be read once. A 204 has none.
  const fetch = vi.fn().mockImplementation(async () => new Response(status === 204 ? null : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const call = (fetch: ReturnType<typeof stubFetch>) => {
  const [url, init] = fetch.mock.calls[0]!;
  return { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined };
};

describe('api passkeys and unlock', () => {
  it('reads the status with the Proton state', async () => {
    const status = { email: 'user@example.test', proton: 'locked', passkeys: 1, unlockAvailable: true };
    stubFetch(status);
    await expect(api.status()).resolves.toEqual(status);
  });

  it('begins and adds a passkey', async () => {
    let fetch = stubFetch({ salt: 's', userHandle: 'h', excludeCredentials: [] });
    await api.passkeys.begin();
    expect(call(fetch)).toEqual({ url: '/api/passkeys/begin', method: 'POST', body: undefined });
    fetch = stubFetch({ credentialId: 'id', label: 'Phone', createdAt: 't', lastUsedAt: null }, 201);
    await api.passkeys.add({ credentialId: 'id', salt: 's', prf: 'p', label: 'Phone' });
    expect(call(fetch)).toEqual({ url: '/api/passkeys', method: 'POST', body: { credentialId: 'id', salt: 's', prf: 'p', label: 'Phone' } });
  });

  it('lists passkeys and removes one by its escaped id', async () => {
    let fetch = stubFetch({ passkeys: [], notice: null });
    await expect(api.passkeys.list()).resolves.toEqual({ passkeys: [], notice: null });
    expect(call(fetch)).toMatchObject({ url: '/api/passkeys', method: 'GET' });
    fetch = stubFetch(null, 204);
    await api.passkeys.remove('a-b_c');
    expect(call(fetch)).toMatchObject({ url: '/api/passkeys/a-b_c', method: 'DELETE' });
  });

  it('begins an unlock, then sends the PRF output', async () => {
    let fetch = stubFetch({ credentials: [{ credentialId: 'id', salt: 's' }] });
    await expect(api.unlock.begin()).resolves.toEqual({ credentials: [{ credentialId: 'id', salt: 's' }] });
    expect(call(fetch)).toMatchObject({ url: '/api/auth/unlock/begin', method: 'POST' });
    fetch = stubFetch({ email: 'user@example.test', proton: 'live', passkeys: 1, unlockAvailable: true });
    await api.unlock({ credentialId: 'id', prf: 'p' });
    expect(call(fetch)).toEqual({ url: '/api/auth/unlock', method: 'POST', body: { credentialId: 'id', prf: 'p' } });
  });

  it('surfaces an unlock error code', async () => {
    stubFetch({ error: 'unlock_failed' }, 401);
    await expect(api.unlock({ credentialId: 'id', prf: 'p' })).rejects.toMatchObject({ status: 401, code: 'unlock_failed' });
  });
});
