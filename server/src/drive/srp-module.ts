import type { SRPModule, SRPVerifier } from '@protontech/drive-sdk/dist/crypto/interface.js';
import { getSrp } from '../vendor/proton-srp/srp.js';
import { computeKeyPassword as vendorComputeKeyPassword } from '../vendor/proton-srp/keys.js';
import { installCryptoImpl } from '../auth/crypto-impl.js';

/**
 * Adapter exposing the vendored Proton SRP primitives through the SDK's
 * SRPModule interface. The SDK calls these methods from DriveCrypto and from
 * the public-link session flow; all three methods are stateless wrappers
 * around the vendored crypto code.
 *
 * `getSrpVerifier` is used by the SDK only for password-change flows, which
 * are out of scope for Phase 2 (read-only Drive access). We throw a clear
 * error so a future phase can wire it up explicitly when needed.
 */
export class DriveSrpModule implements SRPModule {
  constructor() {
    // The vendored SRP code requires the OpenPGP-backed crypto helpers to
    // be installed (same as ProtonAuth). Idempotent.
    installCryptoImpl();
  }

  getSrp = async (
    version: number,
    modulus: string,
    serverEphemeral: string,
    salt: string,
    password: string,
  ): Promise<{ expectedServerProof: string; clientProof: string; clientEphemeral: string }> => {
    const proof = await getSrp(
      { Version: version, Modulus: modulus, ServerEphemeral: serverEphemeral, Salt: salt },
      { password },
      version,
    );
    return {
      expectedServerProof: proof.expectedServerProof,
      clientProof: proof.clientProof,
      clientEphemeral: proof.clientEphemeral,
    };
  };

  getSrpVerifier = async (_password: string): Promise<SRPVerifier> => {
    throw new Error(
      'DriveSrpModule.getSrpVerifier is not implemented (password-change flows are out of scope for Phase 2)',
    );
  };

  computeKeyPassword = async (password: string, salt: string): Promise<string> => {
    return vendorComputeKeyPassword(password, salt);
  };
}
