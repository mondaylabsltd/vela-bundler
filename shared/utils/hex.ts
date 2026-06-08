/**
 * Hex utility functions.
 */

import {
  concat,
  encodePacked,
  hexToBigInt,
  keccak256,
  numberToHex,
  padHex,
  size as hexSize,
  toHex,
} from "viem";

export {
  concat,
  encodePacked,
  hexToBigInt,
  keccak256,
  numberToHex,
  padHex,
  hexSize,
  toHex,
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;
export const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
export const EMPTY_BYTES = "0x" as `0x${string}`;

/**
 * Pack two uint128 values into a single bytes32.
 * high128 occupies upper 16 bytes, low128 occupies lower 16 bytes.
 */
export function packUint128(high: bigint, low: bigint): `0x${string}` {
  const h = padHex(numberToHex(high), { size: 16, dir: "left" });
  const l = padHex(numberToHex(low), { size: 16, dir: "left" });
  return concat([h, l]);
}

/**
 * Count zero and non-zero bytes in a hex string.
 */
export function countCalldataBytes(hex: `0x${string}`): { zeroBytes: number; nonZeroBytes: number } {
  const raw = hex.slice(2);
  // Odd-length hex: pad with leading zero so byte boundaries are correct
  const padded = raw.length % 2 !== 0 ? "0" + raw : raw;
  let zeroBytes = 0;
  let nonZeroBytes = 0;
  for (let i = 0; i < padded.length; i += 2) {
    const byte = padded.slice(i, i + 2);
    if (byte === "00") {
      zeroBytes++;
    } else {
      nonZeroBytes++;
    }
  }
  return { zeroBytes, nonZeroBytes };
}

/**
 * Calculate calldata gas for a hex-encoded byte string.
 * Zero bytes cost 4 gas, non-zero bytes cost 16 gas.
 */
export function calldataGasCost(hex: `0x${string}`): bigint {
  const { zeroBytes, nonZeroBytes } = countCalldataBytes(hex);
  return BigInt(zeroBytes * 4 + nonZeroBytes * 16);
}

/**
 * Check if a hex string is effectively empty (0x or 0x00...00).
 */
export function isEmptyHex(hex: `0x${string}` | null | undefined): boolean {
  if (!hex) return true;
  if (hex === "0x") return true;
  return /^0x0*$/.test(hex);
}
