import { getSrp } from '../vendor/proton-srp/srp.js';
import { AUTH_VERSION } from '../vendor/proton-srp/constants.js';
import { computeKeyPassword } from '../vendor/proton-srp/keys.js';
import type { ProtonApi, AuthResponse } from './proton-api.js';
import { installCryptoImpl } from './crypto-impl.js';
import { MailboxSecret } from './secrets/mailbox-password.js';
import { fetchAndDecryptUserKey, type DecryptedUserKey } from './keys.js';

export interface ProtonSession {
  uid: string;
  accessToken: string;
  refreshToken: string;
  email: string;
}

export interface LoginResult {
  session: ProtonSession;
  mailboxSecret: MailboxSecret;
  decryptedKeys: DecryptedUserKey;
}

export class AuthVersionError extends Error {
  constructor(version: number) {
    super(`Unsupported Proton auth version ${version} (expected ${AUTH_VERSION})`);
    this.name = 'AuthVersionError';
  }
}

export class TwoFactorRequiredError extends Error {
  constructor(public readonly partial: AuthResponse) {
    super('TOTP code required');
    this.name = 'TwoFactorRequiredError';
  }
}

export class ProtonAuth {
  constructor(private readonly api: ProtonApi) {
    installCryptoImpl();
  }

  async login(email: string, password: string, totp?: string): Promise<LoginResult> {
    const info = await this.api.getAuthInfo(email);
    if (info.Version !== AUTH_VERSION) throw new AuthVersionError(info.Version);

    // getSrp returns { clientEphemeral, clientProof, expectedServerProof, sharedSession }
    // where clientEphemeral and clientProof are already base64-encoded strings.
    const proof = await getSrp(info, { username: email, password });

    const auth = await this.api.submitAuth({
      Username: email,
      ClientEphemeral: proof.clientEphemeral,
      ClientProof: proof.clientProof,
      SRPSession: info.SRPSession,
    });

    if (auth['2FA']?.Enabled) {
      if (!totp) throw new TwoFactorRequiredError(auth);
      await this.api.submit2FA(auth.UID, auth.AccessToken, totp);
    }

    // Fetch keysalts + user to derive mailbox passphrase for the primary key.
    const { KeySalts } = await this.api.getKeySalts(auth.UID, auth.AccessToken);
    const { User } = await this.api.getUser(auth.UID, auth.AccessToken);
    const primaryKey = User.Keys.find((k) => k.Primary === 1 && k.Active === 1);
    if (!primaryKey) throw new Error('User has no primary active key');
    const saltEntry = KeySalts.find((s) => s.ID === primaryKey.ID);
    if (!saltEntry) throw new Error(`No KeySalt for primary key ${primaryKey.ID}`);

    const mailboxPassphrase = await computeKeyPassword(password, saltEntry.KeySalt);
    const mailboxPasswordBytes = new TextEncoder().encode(mailboxPassphrase);
    const mailboxSecret = new MailboxSecret(mailboxPasswordBytes);

    const decryptedKeys = await fetchAndDecryptUserKey({
      api: this.api,
      uid: auth.UID,
      accessToken: auth.AccessToken,
      mailboxPasswordBytes,
    });

    return {
      session: {
        uid: auth.UID,
        accessToken: auth.AccessToken,
        refreshToken: auth.RefreshToken,
        email,
      },
      mailboxSecret,
      decryptedKeys,
    };
  }

  async refresh(session: ProtonSession): Promise<ProtonSession> {
    const refreshed = await this.api.refresh(session.uid, session.refreshToken);
    return {
      uid: refreshed.UID,
      accessToken: refreshed.AccessToken,
      refreshToken: refreshed.RefreshToken,
      email: session.email,
    };
  }
}
