/**
 * LocalKeyManager — derives keys from an operator secret stored in env.
 *
 * For production, consider replacing with KMS/HSM/MPC implementation
 * of the KeyManager interface.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { KeyManager, KeyDerivationParams, DerivedEOA } from "./types.ts";
import { deriveEOAPrivateKey } from "./derive.ts";

export class LocalKeyManager implements KeyManager {
  private readonly operatorSecret: string;
  private readonly activeKeyVersion: string;
  private readonly drainingKeyVersions: string[];

  constructor(params: {
    operatorSecret: string;
    activeKeyVersion: string;
    drainingKeyVersions?: string[];
  }) {
    if (!params.operatorSecret) {
      throw new Error("operatorSecret is required");
    }
    // Validate: must be a hex string that decodes to at least 32 bytes (256 bits)
    const clean = params.operatorSecret.startsWith("0x")
      ? params.operatorSecret.slice(2)
      : params.operatorSecret;
    if (!/^[0-9a-fA-F]+$/.test(clean)) {
      throw new Error("operatorSecret must be a hex string (with or without 0x prefix)");
    }
    if (clean.length < 64) {
      throw new Error(
        `operatorSecret must be at least 32 bytes (64 hex chars), got ${clean.length / 2} bytes`,
      );
    }
    this.operatorSecret = params.operatorSecret;
    this.activeKeyVersion = params.activeKeyVersion;
    this.drainingKeyVersions = params.drainingKeyVersions ?? [];
  }

  async deriveEOA(params: KeyDerivationParams): Promise<DerivedEOA> {
    const privateKey = await deriveEOAPrivateKey(
      this.operatorSecret,
      params.chainId,
      params.entryPoint,
      params.safeAddress,
      params.keyVersion,
    );
    const account = privateKeyToAccount(privateKey);
    return {
      address: account.address.toLowerCase() as `0x${string}`,
      privateKey,
    };
  }

  async signTransaction(
    params: KeyDerivationParams,
    serializedTx: Uint8Array,
  ): Promise<`0x${string}`> {
    const eoa = await this.deriveEOA(params);
    if (!eoa.privateKey) {
      throw new Error("LocalKeyManager always provides privateKey");
    }
    const account = privateKeyToAccount(eoa.privateKey);
    return await account.signTransaction({
      serializedTransaction: ("0x" +
        Array.from(serializedTx)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")) as `0x${string}`,
    } as Parameters<typeof account.signTransaction>[0]);
  }

  getActiveKeyVersion(): string {
    return this.activeKeyVersion;
  }

  getDrainingKeyVersions(): string[] {
    return [...this.drainingKeyVersions];
  }
}
