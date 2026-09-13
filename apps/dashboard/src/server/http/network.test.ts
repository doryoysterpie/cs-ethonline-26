import { describe, expect, it } from 'vitest';

import type { DashboardConfig } from '../config.ts';
import { networkKey } from './network.ts';

const base: DashboardConfig = {
  environment: 'local',
  accountStore: 'memory',
  memorySeedPath: '/tmp/seed.json',
  databaseSchema: 'public',
  trustForwardedFor: false,
};

describe('network key', () => {
  it('is direct unless a trusted proxy is declared', () => {
    expect(networkKey(new Headers({ 'x-forwarded-for': '203.0.113.9' }), base)).toBe('direct');
  });

  it('uses the first trusted hop, bounded to address characters', () => {
    const trusted = { ...base, trustForwardedFor: true };
    expect(networkKey(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }), trusted)).toBe(
      '203.0.113.9',
    );
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
