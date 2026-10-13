import { describe, it, expect, vi, afterEach } from 'vitest';
import { enrol, unlock } from '../../src/auth/flows.js';
import { toBase64url } from '../../src/auth/passkeys.js';
import { domError, fakeCredential, installCredentials, removeCredentials } from './fake-webauthn.js';

afterEach(() => {
  removeCredentials();
  vi.unstubAllGlobals();
});

const ID = toBase64url(new Uint8Array(16).fill(1));
const PRF = new Uint8Array(32).fill(7);
const SALT = toBase64url(new Uint8Array(32).fill(3));
const BEGIN = { salt: SALT, userHandle: toBase64url(new Uint8Array(16).fill(9)), excludeCredentials: [] };
const STATUS = { email: 'user@example.test', proton: 'live', passkeys: 1, unlockAvailable: true };
const ENTRY = { credentialId: ID, label: 'Phone', createdAt: '2026-10-13T10:00:00.000Z', lastUsedAt: null };

/** A fresh Response per call (a body reads once), routed by method and path. */
function server(routes: Record<string, () => Response>) {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const handler = routes[`${init?.method ?? 'GET'} ${String(input)}`];
    return handler ? handler() : new Response('{"error":"not_found"}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
const bodyOf = (fetch: ReturnType<typeof server>, path: string) =>
  JSON.parse(String(fetch.mock.calls.find(([url]) => url === path)![1]!.body));

describe('unlock', () => {
  it('fetches the salts, asks for the passkey, and sends its PRF output', async () => {
    const fetch = server({
      'POST /api/auth/unlock/begin': json({ credentials: [{ credentialId: ID, salt: SALT }] }),
      'POST /api/auth/unlock': json(STATUS),
    });
    installCredentials().get.mockResolvedValue(fakeCredential(ID, PRF));
    expect(await unlock()).toEqual({ kind: 'unlocked', status: STATUS });
    expect(bodyOf(fetch, '/api/auth/unlock')).toEqual({ credentialId: ID, prf: toBase64url(PRF) });
  });

  it('uses salts fetched before the tap', async () => {
    const fetch = server({ 'POST /api/auth/unlock': json(STATUS) });
    installCredentials().get.mockResolvedValue(fakeCredential(ID, PRF));
    expect(await unlock([{ credentialId: ID, salt: SALT }])).toMatchObject({ kind: 'unlocked' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/unlock']);
  });

  it('sends nothing when the prompt is cancelled', async () => {
    const fetch = server({});
    installCredentials().get.mockRejectedValue(domError('NotAllowedError'));
    expect(await unlock([{ credentialId: ID, salt: SALT }])).toEqual({ kind: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes the server's refusal on as its code", async () => {
    server({ 'POST /api/auth/unlock': json({ error: 'passkeys_stale' }, 409) });
    installCredentials().get.mockResolvedValue(fakeCredential(ID, PRF));
    expect(await unlock([{ credentialId: ID, salt: SALT }])).toEqual({ kind: 'failed', code: 'passkeys_stale' });
  });

  it('fails as unlock_failed when the passkey gives no PRF output', async () => {
    server({});
    installCredentials().get.mockResolvedValue(fakeCredential(ID, null));
    expect(await unlock([{ credentialId: ID, salt: SALT }])).toEqual({ kind: 'failed', code: 'unlock_failed' });
  });
});

describe('enrol', () => {
  it('begins, creates the passkey, and stores it with its label', async () => {
    const fetch = server({ 'POST /api/passkeys/begin': json(BEGIN), 'POST /api/passkeys': json(ENTRY, 201) });
    installCredentials().create.mockResolvedValue(fakeCredential(ID, PRF));
    expect(await enrol('Phone', 'user@example.test')).toEqual({ kind: 'added', passkey: ENTRY });
    expect(bodyOf(fetch, '/api/passkeys')).toEqual({ credentialId: ID, salt: SALT, prf: toBase64url(PRF), label: 'Phone' });
  });

  it('uses a begin fetched before the tap', async () => {
    const fetch = server({ 'POST /api/passkeys': json(ENTRY, 201) });
    installCredentials().create.mockResolvedValue(fakeCredential(ID, PRF));
    expect(await enrol('Phone', 'user@example.test', BEGIN)).toMatchObject({ kind: 'added' });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/passkeys']);
  });

  it('stores nothing for a passkey without PRF, and asks the password manager to hide it', async () => {
    const fetch = server({});
    const c = installCredentials();
    c.create.mockResolvedValue(fakeCredential(ID, null));
    c.get.mockResolvedValue(fakeCredential(ID, null));
    const signalUnknownCredential = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential });
    expect(await enrol('Phone', 'user@example.test', BEGIN)).toEqual({ kind: 'prf_unsupported', forgotten: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(signalUnknownCredential).toHaveBeenCalledWith({ rpId: location.hostname, credentialId: ID });
  });

  it('says setup expired when the server lost the salt', async () => {
    server({ 'POST /api/passkeys': json({ error: 'invalid_enrolment' }, 400) });
    installCredentials().create.mockResolvedValue(fakeCredential(ID, PRF));
    vi.stubGlobal('PublicKeyCredential', undefined);
    expect(await enrol('Phone', 'user@example.test', BEGIN)).toEqual({ kind: 'expired', forgotten: false });
  });

  it('finishes setup from a later tap', async () => {
    server({ 'POST /api/passkeys': json(ENTRY, 201) });
    const c = installCredentials();
    c.create.mockResolvedValue(fakeCredential(ID, null));
    c.get.mockRejectedValueOnce(domError('NotAllowedError')).mockResolvedValueOnce(fakeCredential(ID, PRF));
    const first = await enrol('Phone', 'user@example.test', BEGIN);
    if (first.kind !== 'finish_setup') throw new Error(`expected finish_setup, got ${first.kind}`);
    expect(await first.finish()).toEqual({ kind: 'added', passkey: ENTRY });
  });

  it('asks the password manager to hide a passkey abandoned at Finish setup', async () => {
    server({});
    const c = installCredentials();
    c.create.mockResolvedValue(fakeCredential(ID, null));
    c.get.mockRejectedValue(domError('NotAllowedError'));
    const signalUnknownCredential = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential });
    const first = await enrol('Phone', 'user@example.test', BEGIN);
    if (first.kind !== 'finish_setup') throw new Error(`expected finish_setup, got ${first.kind}`);
    expect(await first.abandon()).toBe(true);
    expect(signalUnknownCredential).toHaveBeenCalledWith({ rpId: location.hostname, credentialId: ID });
  });

  it('asks the password manager to hide a passkey the server refused', async () => {
    server({ 'POST /api/passkeys': json({ error: 'proton_not_live' }, 409) });
    installCredentials().create.mockResolvedValue(fakeCredential(ID, PRF));
    const signalUnknownCredential = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential });
    expect(await enrol('Phone', 'user@example.test', BEGIN)).toEqual({ kind: 'failed', code: 'proton_not_live', forgotten: true });
    expect(signalUnknownCredential).toHaveBeenCalledWith({ rpId: location.hostname, credentialId: ID });
  });

  it('keeps a passkey whose add never got an answer: the server may have stored it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    installCredentials().create.mockResolvedValue(fakeCredential(ID, PRF));
    const signalUnknownCredential = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential });
    expect(await enrol('Phone', 'user@example.test', BEGIN)).toEqual({ kind: 'failed', code: 'error' });
    expect(signalUnknownCredential).not.toHaveBeenCalled();
  });

  it('maps a cancelled prompt and an already-added passkey, and fails on a server error', async () => {
    server({ 'POST /api/passkeys/begin': json({ error: 'proton_not_live' }, 409) });
    const c = installCredentials();
    c.create.mockRejectedValueOnce(domError('NotAllowedError'));
    expect(await enrol('Phone', 'user@example.test', BEGIN)).toEqual({ kind: 'cancelled' });
    c.create.mockRejectedValueOnce(domError('InvalidStateError'));
    expect(await enrol('Phone', 'user@example.test', BEGIN)).toEqual({ kind: 'already_added' });
    expect(await enrol('Phone', 'user@example.test')).toEqual({ kind: 'failed', code: 'proton_not_live' });
  });
});
