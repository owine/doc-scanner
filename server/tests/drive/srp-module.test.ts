import { describe, it, expect } from 'vitest';
import { DriveSrpModule } from '../../src/drive/srp-module.js';
import { computeKeyPassword as vendorComputeKeyPassword } from '../../src/vendor/proton-srp/keys.js';

describe('DriveSrpModule', () => {
  describe('computeKeyPassword', () => {
    it('matches the vendored computeKeyPassword output', async () => {
      // 16 random bytes base64-encoded → 24-char salt as required by bcrypt prefix logic.
      const salt = Buffer.from(new Uint8Array(16).fill(7)).toString('base64');
      expect(salt).toHaveLength(24);

      const mod = new DriveSrpModule();
      const got = await mod.computeKeyPassword('hunter2', salt);
      const want = await vendorComputeKeyPassword('hunter2', salt);

      expect(got).toBe(want);
      // Sanity: bcrypt strips prefix+salt, leaving the 31-char hash portion.
      expect(got).toHaveLength(31);
    });

    it('rejects invalid inputs (delegates vendor validation)', async () => {
      const mod = new DriveSrpModule();
      await expect(mod.computeKeyPassword('', 'x'.repeat(24))).rejects.toThrow(
        /password and salt required/i,
      );
    });
  });

  describe('getSrp', () => {
    it('throws on malformed modulus (delegates vendor verification)', async () => {
      // The vendor code calls verifyAndGetModulus which requires a signed PGP modulus.
      // A non-PGP string should fail before any SRP math runs — proving delegation.
      const mod = new DriveSrpModule();
      await expect(
        mod.getSrp(4, 'not-a-real-modulus', 'AAAA', 'c2FsdHNhbHQ=', 'pw'),
      ).rejects.toThrow();
    });
  });

  describe('getSrpVerifier', () => {
    it('throws "not implemented" — password-change is out of scope for Phase 2', async () => {
      const mod = new DriveSrpModule();
      await expect(mod.getSrpVerifier('pw')).rejects.toThrow(/not implemented/i);
    });
  });
});
