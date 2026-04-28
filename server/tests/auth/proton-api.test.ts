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

  it('throws on non-2xx with response body', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{"Code":2001,"Error":"Bad request"}', { status: 422 }));
    const api = new ProtonApi('https://api.example.test', 'external-drive-docscanner@0.1.0');
    await expect(api.getAuthInfo('user@example.com')).rejects.toThrow(/Bad request/);
  });
});
