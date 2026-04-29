import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ProtonApi } from '../../src/auth/proton-api.js';

const mockFetch = vi.fn();
beforeEach(() => { mockFetch.mockReset(); global.fetch = mockFetch as any; });
afterEach(() => { vi.restoreAllMocks(); });

describe('ProtonApi', () => {
  it('GET /auth/info sends username and parses response', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      Version: 4, Modulus: 'mod', ServerEphemeral: 'eph', Salt: 'salt', SRPSession: 'sess',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const api = new ProtonApi('https://api.example.test', 'external-drive-docscanner@0.1.0');
    const info = await api.getAuthInfo('user@example.com');

    expect(info.SRPSession).toBe('sess');
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toContain('/auth/v4/info');
    expect((init as RequestInit).headers).toMatchObject({ 'x-pm-appversion': 'external-drive-docscanner@0.1.0' });
  });

  it('GET /core/v4/users sends uid + bearer headers and parses User', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      User: { ID: 'u1', Name: 'n', Currency: 'USD', Email: 'e@x', DisplayName: 'd', Keys: [] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const api = new ProtonApi('https://api.example.test', 'external-drive-docscanner@0.1.0');
    const res = await api.getUser('uid-1', 'at-1');

    expect(res.User.ID).toBe('u1');
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toContain('/core/v4/users');
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).body).toBeUndefined();
    expect((init as RequestInit).headers).toMatchObject({
      'x-pm-uid': 'uid-1',
      authorization: 'Bearer at-1',
    });
  });

  it('GET /core/v4/keys/salts sends uid + bearer headers and parses KeySalts', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      KeySalts: [{ ID: 'k1', KeySalt: 'c2FsdC1iYXNlNjQtMTYtYnk=' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const api = new ProtonApi('https://api.example.test', 'external-drive-docscanner@0.1.0');
    const res = await api.getKeySalts('uid-2', 'at-2');

    expect(res.KeySalts).toHaveLength(1);
    expect(res.KeySalts[0]!.ID).toBe('k1');
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toContain('/core/v4/keys/salts');
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).body).toBeUndefined();
    expect((init as RequestInit).headers).toMatchObject({
      'x-pm-uid': 'uid-2',
      authorization: 'Bearer at-2',
    });
  });

  it('throws on non-2xx with response body', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{"Code":2001,"Error":"Bad request"}', { status: 422 }));
    const api = new ProtonApi('https://api.example.test', 'external-drive-docscanner@0.1.0');
    await expect(api.getAuthInfo('user@example.com')).rejects.toThrow(/Bad request/);
  });
});
