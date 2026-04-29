export interface AuthInfo {
  Version: number;
  Modulus: string;
  ServerEphemeral: string;
  Salt: string;
  SRPSession: string;
  '2FA'?: { Enabled: number; TOTP: number; FIDO2?: unknown };
}

export interface AuthResponse {
  AccessToken: string;
  RefreshToken: string;
  TokenType: string;
  Scope: string;
  UID: string;
  UserID: string;
  EventID: string;
  '2FA'?: { Enabled: number };
}

export interface ProtonUserKey {
  ID: string;
  Version: number;
  Primary: number;
  Active: number;
  Flags: number;
  PrivateKey: string;
  Fingerprint: string;
  Address?: string;
}

export interface ProtonUser {
  ID: string;
  Name: string;
  Currency: string;
  Email: string;
  DisplayName: string;
  Keys: ProtonUserKey[];
}

export interface KeySaltEntry {
  ID: string;
  KeySalt: string;
}

export interface ProtonAddressKey {
  ID: string;
  Version: number;
  Primary: number;
  Active: number;
  Flags: number;
  PrivateKey: string;
  Token?: string | null;
  Signature?: string | null;
  Fingerprint: string;
}

export interface ProtonAddress {
  ID: string;
  Email: string;
  Status: number;
  Type: number;
  Order: number;
  Receive: number;
  Send: number;
  Keys: ProtonAddressKey[];
}

export class ProtonApi {
  constructor(private readonly baseUrl: string, private readonly appVersion: string) {}

  async getAuthInfo(username: string): Promise<AuthInfo> {
    return this.request<AuthInfo>('POST', '/auth/v4/info', { Username: username });
  }

  async submitAuth(body: {
    Username: string;
    ClientEphemeral: string;
    ClientProof: string;
    SRPSession: string;
  }): Promise<AuthResponse> {
    return this.request<AuthResponse>('POST', '/auth/v4', body);
  }

  async submit2FA(uid: string, accessToken: string, totp: string): Promise<{ Code: number }> {
    return this.request<{ Code: number }>('POST', '/auth/v4/2fa', { TwoFactorCode: totp }, {
      'x-pm-uid': uid,
      authorization: `Bearer ${accessToken}`,
    });
  }

  async getUser(uid: string, accessToken: string): Promise<{ User: ProtonUser }> {
    return this.request<{ User: ProtonUser }>('GET', '/core/v4/users', undefined, {
      'x-pm-uid': uid,
      authorization: `Bearer ${accessToken}`,
    });
  }

  async getAddresses(uid: string, accessToken: string): Promise<{ Addresses: ProtonAddress[] }> {
    return this.request<{ Addresses: ProtonAddress[] }>('GET', '/core/v4/addresses', undefined, {
      'x-pm-uid': uid,
      authorization: `Bearer ${accessToken}`,
    });
  }

  async getKeySalts(uid: string, accessToken: string): Promise<{ KeySalts: KeySaltEntry[] }> {
    return this.request<{ KeySalts: KeySaltEntry[] }>('GET', '/core/v4/keys/salts', undefined, {
      'x-pm-uid': uid,
      authorization: `Bearer ${accessToken}`,
    });
  }

  async refresh(uid: string, refreshToken: string): Promise<AuthResponse> {
    return this.request<AuthResponse>('POST', '/auth/v4/refresh', {
      ResponseType: 'token',
      GrantType: 'refresh_token',
      RefreshToken: refreshToken,
      RedirectURI: 'https://protonmail.com',
    }, { 'x-pm-uid': uid });
  }

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': `Mozilla/5.0 (compatible; ${this.appVersion})`,
        'x-pm-appversion': this.appVersion,
        ...extraHeaders,
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${this.baseUrl}${path}`, init);
    const text = await res.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
    if (!res.ok) {
      const err = parsed as { Error?: string; Code?: number };
      throw new ProtonApiError(err.Error ?? `HTTP ${res.status}`, res.status, err.Code);
    }
    return parsed as T;
  }
}

export class ProtonApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: number) {
    super(message);
    this.name = 'ProtonApiError';
  }
}
