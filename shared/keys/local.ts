/**
 * LocalKeyManager — derives keys from an operator secret stored in env.
 *
 * For production, consider replacing with KMS/HSM/MPC implementation
 * of the KeyManager interface.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { KeyManager, KeyDerivationParams, DerivedEOA } from "./types.ts";
import { deriveEOAPrivateKey, derivePoolRelayerPrivateKey, validateOperatorSecret } from "./derive.ts";

const validateSecret = validateOperatorSecret;

export class LocalKeyManager implements KeyManager {
  private readonly operatorSecret: string;
  private readonly oldSecrets: string[];

  constructor(params: {
    operatorSecret: string;
    oldOperatorSecrets?: string[];
  }) {
    validateSecret(params.operatorSecret, "operatorSecret");
    for (let i = 0; i < (params.oldOperatorSecrets?.length ?? 0); i++) {
      validateSecret(params.oldOperatorSecrets![i]!, `oldOperatorSecrets[${i}]`);
    }
    this.operatorSecret = params.operatorSecret;
    this.oldSecrets = params.oldOperatorSecrets ?? [];
  }

  async deriveEOA(params: KeyDerivationParams): Promise<DerivedEOA> {
    const privateKey = await deriveEOAPrivateKey(
      this.operatorSecret,
      params.chainId,
      params.entryPoint,
      params.safeAddress,
    );
    const account = privateKeyToAccount(privateKey);
    return {
      address: account.address.toLowerCase() as `0x${string}`,
      privateKey,
    };
  }

  async derivePoolEOA(index: number): Promise<DerivedEOA> {
    const privateKey = await derivePoolRelayerPrivateKey(this.operatorSecret, index);
    const account = privateKeyToAccount(privateKey);
    return {
      address: account.address.toLowerCase() as `0x${string}`,
      privateKey,
    };
  }

  getOldSecrets(): string[] {
    return [...this.oldSecrets];
  }
}
