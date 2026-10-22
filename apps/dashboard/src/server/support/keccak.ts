import 'server-only';

/**
 * Keccak-256 as Ethereum uses it (the original padding, not FIPS 202's
 * SHA3-256, which Node's OpenSSL offers and which differs in the padding
 * byte). Needed only to check the EIP-55 mixed-case checksum of a pinned
 * donation address, so a typo in the policy file fails a test rather than
 * reaching a page. Forty bytes of input at most in practice; clarity over
 * speed, on 64-bit lanes as BigInt.
 */
const MASK = (1n << 64n) - 1n;
const ROUNDS = 24;
const RATE_BYTES = 136;

const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

/** Rotation offsets r[x][y]. */
const ROTATIONS: readonly (readonly number[])[] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const lane = (state: readonly bigint[], index: number): bigint => state[index] ?? 0n;
const rotation = (x: number, y: number): number => ROTATIONS[x]?.[y] ?? 0;

function rotl(value: bigint, bits: number): bigint {
  if (bits === 0) return value;
  return ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & MASK;
}

function keccakF(state: bigint[]): void {
  for (let round = 0; round < ROUNDS; round += 1) {
    // theta
    const c: bigint[] = [];
    for (let x = 0; x < 5; x += 1) {
      c.push(
        lane(state, x) ^
          lane(state, x + 5) ^
          lane(state, x + 10) ^
          lane(state, x + 15) ^
          lane(state, x + 20),
      );
    }
    for (let x = 0; x < 5; x += 1) {
      const d = lane(c, (x + 4) % 5) ^ rotl(lane(c, (x + 1) % 5), 1);
      for (let y = 0; y < 5; y += 1) state[x + 5 * y] = lane(state, x + 5 * y) ^ d;
    }
    // rho and pi
    const b: bigint[] = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(lane(state, x + 5 * y), rotation(x, y));
      }
    }
    // chi
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] =
          lane(b, x + 5 * y) ^
          (~lane(b, ((x + 1) % 5) + 5 * y) & MASK & lane(b, ((x + 2) % 5) + 5 * y));
      }
    }
    // iota
    state[0] = lane(state, 0) ^ (ROUND_CONSTANTS[round] ?? 0n);
  }
}

export function keccak256(input: Uint8Array): Uint8Array {
  const blocks = Math.ceil((input.length + 1) / RATE_BYTES);
  const padded = new Uint8Array(blocks * RATE_BYTES);
  padded.set(input);
  padded[input.length] = (padded[input.length] ?? 0) ^ 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) ^ 0x80;
  const state: bigint[] = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let index = 0; index < RATE_BYTES / 8; index += 1) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte -= 1) {
        value = (value << 8n) | BigInt(padded[offset + index * 8 + byte] ?? 0);
      }
      state[index] = lane(state, index) ^ value;
    }
    keccakF(state);
  }
  const out = new Uint8Array(32);
  for (let index = 0; index < 4; index += 1) {
    let value = lane(state, index);
    for (let byte = 0; byte < 8; byte += 1) {
      out[index * 8 + byte] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return out;
}

export function keccak256Hex(input: Uint8Array): string {
  return Buffer.from(keccak256(input)).toString('hex');
}
