import { describe, expect, it } from 'vitest';

import {
  constantTimeEqual,
  csrfTokenFor,
  generateSessionToken,
  hashSessionToken,
  isSessionTokenShaped,
} from './tokens.ts';

describe('session tokens', () => {
  it('issues 32 random bytes as 43 base64url characters, distinct every time', () => {
    const tokens = new Set(Array.from({ length: 64 }, () => generateSessionToken()));
    expect(tokens.size).toBe(64);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(isSessionTokenShaped(token)).toBe(true);
    }
    expect(isSessionTokenShaped('short')).toBe(false);
    expect(isSessionTokenShaped(`${'a'.repeat(43)}=`)).toBe(false);
    expect(isSessionTokenShaped(42)).toBe(false);
  });

  it('hashes to SHA-256 hex, and the hash reveals nothing usable as a token', () => {
    const token = generateSessionToken();
    const digest = hashSessionToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(digest).toBe(hashSessionToken(token));
    expect(isSessionTokenShaped(digest)).toBe(false);
  });

  it('derives a CSRF token bound to the session token', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(csrfTokenFor(a)).toBe(csrfTokenFor(a));
    expect(csrfTokenFor(a)).not.toBe(csrfTokenFor(b));
    expect(csrfTokenFor(a)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(csrfTokenFor(a)).not.toBe(a);
  });

  it('compares in constant time and refuses length mismatches', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
