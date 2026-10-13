import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import * as openpgp from 'openpgp';
import { computeKeyPassword } from '../../src/vendor/proton-srp/keys.js';
import type { ProtonAddress, ProtonApi, ProtonUser } from '../../src/auth/proton-api.js';

// Skip the SRP maths (the integration test covers the real proof); the key
// steps after it are what these tests are about.
vi.mock('../../src/vendor/proton-srp/srp.js', () => ({
  getSrp: vi.fn().mockResolvedValue({ clientEphemeral: 'ce', clientProof: 'cp', expectedServerProof: 'sp' }),
}));

const { ProtonAuth, keySaltFingerprint } = await import('../../src/auth/srp.js');

const PASSWORD = 'correct horse battery staple';
/** 16 bytes in base64: 24 characters, as Proton sends a KeySalt. */
const KEY_SALT = Buffer.alloc(16, 3).toString('base64');

let passphrase: string;
let user: ProtonUser;
let address: ProtonAddress;

beforeAll(async () => {
  passphrase = await computeKeyPassword(PASSWORD, KEY_SALT);
  const { privateKey: userKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'e@x.test' }], passphrase, format: 'armored',
  });
  const tokenPassphrase = 'address-token-passphrase';
  const { privateKey: addressKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ email: 'e@x.test' }], passphrase: tokenPassphrase, format: 'armored',
  });
  const unlocked = await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: userKey }), passphrase });
  const Token = (await openpgp.encrypt({
    message: await openpgp.createMessage({ text: tokenPassphrase }),
    encryptionKeys: unlocked.toPublic(),
    format: 'armored',
  })) as string;
  user = {
    ID: 'user-123', Name: 'e', Currency: 'USD', Email: 'e@x.test', DisplayName: 'E',
    Keys: [{ ID: 'uk1', Version: 4, Primary: 1, Active: 1, Flags: 3, PrivateKey: userKey, Fingerprint: 'f1' }],
  };
  address = {
    ID: 'addr-1', Email: 'e@x.test', Status: 1, Type: 1, Order: 1, Receive: 1, Send: 1,
    Keys: [{ ID: 'ak1', Version: 3, Primary: 1, Active: 1, Flags: 3, PrivateKey: addressKey, Token, Signature: null, Fingerprint: 'f2' }],
  };
});

function fakeApi(overrides: Partial<Record<keyof ProtonApi, unknown>> = {}): ProtonApi {
  return {
    getAuthInfo: vi.fn().mockResolvedValue({ Version: 4, Modulus: 'm', ServerEphemeral: 'se', Salt: 's', SRPSession: 'srp' }),
    submitAuth: vi.fn().mockResolvedValue({ UID: 'uid-1', AccessToken: 'at-1', RefreshToken: 'rt-1' }),
    submit2FA: vi.fn(),
    getKeySalts: vi.fn().mockResolvedValue({ KeySalts: [{ ID: 'uk1', KeySalt: KEY_SALT }] }),
    getUser: vi.fn().mockResolvedValue({ User: user }),
    getAddresses: vi.fn().mockResolvedValue({ Addresses: [address] }),
    refresh: vi.fn(),
    ...overrides,
  } as unknown as ProtonApi;
}

describe('ProtonAuth.login', () => {
  it('returns the Proton user id and the key-salt fingerprint', async () => {
    const result = await new ProtonAuth(fakeApi()).login('e@x.test', PASSWORD);
    expect(result.userId).toBe('user-123');
    expect(result.keySaltFingerprint).toBe(createHash('sha256').update(KEY_SALT).digest('hex'));
    expect(keySaltFingerprint(KEY_SALT)).toBe(result.keySaltFingerprint);
    result.mailboxSecret.dispose();
  });
});
