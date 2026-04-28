import { getSrp } from '../vendor/proton-srp/srp.js';
import { AUTH_VERSION } from '../vendor/proton-srp/constants.js';
import type { ProtonApi, AuthResponse } from './proton-api.js';
import { installCryptoImpl } from './crypto-impl.js';

export interface ProtonSession {
  uid: string;
  accessToken: string;
  refreshToken: string;
  email: string;
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

  async login(email: string, password: string, totp?: string): Promise<ProtonSession> {
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

    return {
      uid: auth.UID,
      accessToken: auth.AccessToken,
      refreshToken: auth.RefreshToken,
      email,
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
