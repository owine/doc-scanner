import { describe, it, expect, beforeAll } from 'vitest';
import { ProtonApi } from '../../src/auth/proton-api.js';
import { ProtonAuth, TwoFactorRequiredError } from '../../src/auth/srp.js';

const RUN = process.env.INTEGRATION === '1';

describe.skipIf(!RUN)('ProtonAuth (integration)', () => {
  let auth: ProtonAuth;
  const email = process.env.PROTON_TEST_EMAIL;
  const password = process.env.PROTON_TEST_PASSWORD;
  const totp = process.env.PROTON_TEST_TOTP;

  beforeAll(() => {
    if (!email || !password) throw new Error('Set PROTON_TEST_EMAIL and PROTON_TEST_PASSWORD');
    const api = new ProtonApi('https://mail.proton.me/api', 'external-drive-docscanner@0.1.0');
    auth = new ProtonAuth(api);
  });

  it('logs in with real credentials', async () => {
    try {
      const session = await auth.login(email!, password!, totp);
      expect(session.uid).toBeTruthy();
      expect(session.accessToken).toBeTruthy();
      expect(session.refreshToken).toBeTruthy();
    } catch (e) {
      if (e instanceof TwoFactorRequiredError && !totp) {
        throw new Error('Account has 2FA enabled — set PROTON_TEST_TOTP');
      }
      throw e;
    }
  }, 30_000);
});
