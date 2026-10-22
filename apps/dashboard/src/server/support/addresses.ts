import 'server-only';

import { createHash } from 'node:crypto';

import { keccak256Hex } from './keccak.ts';

/**
 * Address checks for the pinned donation entries (CAS-008, D46). Each check
 * verifies the address's own checksum, so a transcription error in the
 * policy file fails a test instead of reaching a page: EIP-55 mixed case for
 * an EVM address (the all-lower-case form is refused on purpose, since it
 * carries no checksum), bech32 or bech32m with the BIP-173 / BIP-350
 * checksum for a native-segwit or taproot Bitcoin address, and Base58Check
 * with the double-SHA-256 checksum for a legacy or P2SH one. Pure.
 */

// ---------------------------------------------------------------- EVM

const EVM_SHAPE = /^0x[0-9a-fA-F]{40}$/u;

export function toChecksumAddress(address: string): string | null {
  if (!EVM_SHAPE.test(address)) return null;
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256Hex(Buffer.from(lower, 'ascii'));
  let out = '0x';
  for (let index = 0; index < lower.length; index += 1) {
    const char = lower[index] ?? '';
    const nibble = Number.parseInt(hash[index] ?? '0', 16);
    out += /[a-f]/u.test(char) && nibble >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

/** True only for the EIP-55 checksummed spelling. */
export function isChecksummedEvmAddress(address: string): boolean {
  return toChecksumAddress(address) === address && /[A-F]/u.test(address);
}

// ---------------------------------------------------------------- Bitcoin: bech32 / bech32m

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit += 1) {
      if ((top >>> bit) & 1) checksum ^= BECH32_GENERATOR[bit] ?? 0;
    }
  }
  return checksum >>> 0;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const char of hrp) out.push(char.charCodeAt(0) >>> 5);
  out.push(0);
  for (const char of hrp) out.push(char.charCodeAt(0) & 31);
  return out;
}

/** A mainnet segwit address whose checksum verifies under the encoding its witness version requires. */
export function isSegwitMainnetAddress(address: string): boolean {
  if (address.length < 14 || address.length > 90) return false;
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return false;
  const lower = address.toLowerCase();
  const separator = lower.lastIndexOf('1');
  if (separator !== 2 || lower.slice(0, 2) !== 'bc') return false;
  const data: number[] = [];
  for (const char of lower.slice(separator + 1)) {
    const value = BECH32_CHARSET.indexOf(char);
    if (value < 0) return false;
    data.push(value);
  }
  if (data.length < 7) return false;
  const version = data[0] ?? -1;
  if (version < 0 || version > 16) return false;
  const expected = version === 0 ? BECH32_CONST : BECH32M_CONST;
  if (bech32Polymod([...bech32HrpExpand('bc'), ...data]) !== expected) return false;
  // The program length: convert the 5-bit groups (without version and checksum) to bytes.
  const groups = data.slice(1, -6);
  const bits = groups.length * 5;
  const programBytes = Math.floor(bits / 8);
  if (bits - programBytes * 8 >= 5) return false;
  if (programBytes < 2 || programBytes > 40) return false;
  if (version === 0 && programBytes !== 20 && programBytes !== 32) return false;
  return true;
}

// ---------------------------------------------------------------- Bitcoin: Base58Check

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(text: string): Uint8Array | null {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  let leading = 0;
  for (const char of text) {
    if (char !== '1') break;
    leading += 1;
  }
  return new Uint8Array([...new Array<number>(leading).fill(0), ...bytes]);
}

/** A mainnet P2PKH (version 0) or P2SH (version 5) address with a verified checksum. */
export function isLegacyMainnetAddress(address: string): boolean {
  if (address.length < 26 || address.length > 35) return false;
  const decoded = base58Decode(address);
  if (decoded === null || decoded.length !== 25) return false;
  const version = decoded[0];
  if (version !== 0 && version !== 5) return false;
  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const first = createHash('sha256').update(payload).digest();
  const second = createHash('sha256').update(first).digest();
  return Buffer.from(checksum).equals(second.subarray(0, 4));
}

export function isBitcoinMainnetAddress(address: string): boolean {
  return isSegwitMainnetAddress(address) || isLegacyMainnetAddress(address);
}
