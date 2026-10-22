import { describe, expect, it } from 'vitest';

import type { DashboardConfig } from '../config.ts';
import { networkKey } from './network.ts';

const base: DashboardConfig = {
  environment: 'local',
  accountStore: 'memory',
  memorySeedPath: '/tmp/seed.json',
  databaseSchema: 'public',
  trustForwardedFor: false,
  trustedProxyHops: 1,
};

describe('network key', () => {
  it('is direct unless a trusted proxy is declared', () => {
    expect(networkKey(new Headers({ 'x-forwarded-for': '203.0.113.9' }), base)).toBe('direct');
  });

  it('uses the hop the trusted proxy appended, counted from the right, bounded to address characters', () => {
    const trusted = { ...base, trustForwardedFor: true };
    // A client wrote the first entry; the one trusted proxy appended the last.
    expect(
      networkKey(new Headers({ 'x-forwarded-for': '203.0.113.9, 198.51.100.7' }), trusted),
    ).toBe('198.51.100.7');
    // Two trusted proxies: the client address is the second from the right.
    expect(
      networkKey(new Headers({ 'x-forwarded-for': 'spoofed, 198.51.100.7, 10.0.0.1' }), {
        ...trusted,
        trustedProxyHops: 2,
      }),
    ).toBe('198.51.100.7');
    // Fewer entries than trusted hops: the header did not come through the chain.
    expect(
      networkKey(new Headers({ 'x-forwarded-for': '198.51.100.7' }), {
        ...trusted,
        trustedProxyHops: 2,
      }),
    ).toBe('malformed');
    expect(networkKey(new Headers({ 'x-forwarded-for': '2001:DB8::1' }), trusted)).toBe(
      '2001:db8::1',
    );
    expect(networkKey(new Headers({ 'x-forwarded-for': '<script>' }), trusted)).toBe('malformed');
    expect(networkKey(new Headers({ 'x-forwarded-for': 'a'.repeat(60) }), trusted)).toBe(
      'malformed',
    );
    expect(networkKey(new Headers(), trusted)).toBe('direct');
  });
});
