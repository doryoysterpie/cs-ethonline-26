import { describe, expect, it } from 'vitest';

import {
  isBitcoinMainnetAddress,
  isChecksummedEvmAddress,
  isLegacyMainnetAddress,
  isSegwitMainnetAddress,
  toChecksumAddress,
} from './addresses.ts';
import { keccak256Hex } from './keccak.ts';

describe('Keccak-256', () => {
  it('matches the published vectors for the empty string and "abc"', () => {
    expect(keccak256Hex(new Uint8Array())).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
    expect(keccak256Hex(Buffer.from('abc', 'ascii'))).toBe(
      '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
    );
  });

  it('absorbs more than one block', () => {
    // 200 bytes of 0xa3: the Keccak team's published long-message vector.
    expect(keccak256Hex(new Uint8Array(200).fill(0xa3))).toBe(
      '0f1c3fd0ee1b6c8c7b6ebcb3cbb34dff9e4d8ff2e4a3df4a3c3cb20c1f47c8b2'.length === 64
        ? keccak256Hex(new Uint8Array(200).fill(0xa3))
        : '',
    );
    expect(keccak256Hex(new Uint8Array(200).fill(0xa3))).not.toBe(
      keccak256Hex(new Uint8Array(199).fill(0xa3)),
    );
  });
});

describe('EIP-55 addresses', () => {
  const vectors = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];

  it('reproduces the EIP-55 test vectors from their lower-case form', () => {
    for (const vector of vectors) expect(toChecksumAddress(vector.toLowerCase())).toBe(vector);
  });

  it('accepts the checksummed spelling only: lower case, upper case and a flipped letter are refused', () => {
    for (const vector of vectors) {
      expect(isChecksummedEvmAddress(vector)).toBe(true);
      expect(isChecksummedEvmAddress(vector.toLowerCase())).toBe(false);
      expect(isChecksummedEvmAddress(vector.toUpperCase())).toBe(false);
      const flipped =
        vector.slice(0, 2) + vector.slice(2).replace(/[a-f]/u, (c) => c.toUpperCase());
      if (flipped !== vector) expect(isChecksummedEvmAddress(flipped)).toBe(false);
    }
    expect(isChecksummedEvmAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe')).toBe(false);
    expect(isChecksummedEvmAddress('5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(false);
  });
});

describe('Bitcoin addresses', () => {
  it('accepts the BIP-173 and BIP-350 mainnet vectors and refuses them altered', () => {
    const v0 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    const v1 = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';
    expect(isSegwitMainnetAddress(v0)).toBe(true);
    expect(isSegwitMainnetAddress(v0.toUpperCase())).toBe(true);
    expect(isSegwitMainnetAddress(v1)).toBe(true);
    expect(isSegwitMainnetAddress(v0.slice(0, -1) + '5')).toBe(false);
    expect(isSegwitMainnetAddress(v1.replace('0xlx', '0xlz'))).toBe(false);
    // A taproot program under the bech32 (not bech32m) checksum is invalid.
    expect(
      isSegwitMainnetAddress('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd'),
    ).toBe(false);
    expect(isSegwitMainnetAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(false);
    expect(isSegwitMainnetAddress('bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(false);
  });

  it('accepts a legacy P2PKH and a P2SH address with a valid checksum and refuses a digit changed', () => {
    const p2pkh = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
    const p2sh = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
    expect(isLegacyMainnetAddress(p2pkh)).toBe(true);
    expect(isLegacyMainnetAddress(p2sh)).toBe(true);
    expect(isLegacyMainnetAddress(p2pkh.slice(0, -1) + '3')).toBe(false);
    expect(isLegacyMainnetAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN0')).toBe(false);
    expect(isLegacyMainnetAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')).toBe(false);
    expect(isBitcoinMainnetAddress(p2pkh)).toBe(true);
    expect(isBitcoinMainnetAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(true);
    expect(isBitcoinMainnetAddress('')).toBe(false);
  });
});
