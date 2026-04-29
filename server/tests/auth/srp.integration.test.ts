import { describe, it, expect } from 'vitest';
import { getSharedSession } from '../helpers/integration-session.js';

const RUN = process.env.INTEGRATION === '1';

describe.skipIf(!RUN)('ProtonAuth (integration)', () => {
  it('logs in with real credentials', async () => {
    const shared = await getSharedSession();
    expect(shared.session.uid).toBeTruthy();
    expect(shared.session.accessToken).toBeTruthy();
    expect(shared.session.refreshToken).toBeTruthy();
    expect(shared.decryptedKeys.primaryKey).toBeDefined();
  }, 30_000);
});
