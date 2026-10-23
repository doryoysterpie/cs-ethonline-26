import { describe, expect, it } from 'vitest';

import {
  defaultLimits,
  READS_PER_READER,
  SIGNUP_PER_ADDRESS,
  SIGNUP_PER_NETWORK,
  WindowLimiter,
} from './limits.ts';

describe('the fixed-window limiter (CAS-007)', () => {
  it('allows up to the limit in a window, refuses with the wait, trips once, and resets', () => {
    const limiter = new WindowLimiter(3, 60);
    const t = 1_000;
    expect([1, 2, 3].map(() => limiter.check('k', t).allowed)).toEqual([true, true, true]);
    const fourth = limiter.check('k', t + 10);
    expect(fourth).toEqual({ allowed: false, retryAfterSeconds: 50, firstTrip: true });
    const fifth = limiter.check('k', t + 20);
    expect(fifth).toEqual({ allowed: false, retryAfterSeconds: 40, firstTrip: false });
    expect(limiter.check('other', t + 20).allowed).toBe(true);
    expect(limiter.check('k', t + 60)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
      firstTrip: false,
    });
  });

  it('bounds its memory by dropping the oldest key, and refuses a bad bound', () => {
    const limiter = new WindowLimiter(1, 60, 2);
    limiter.check('a', 0);
    limiter.check('b', 0);
    limiter.check('c', 0);
    // 'a' was dropped, so it is fresh again (and its return drops 'b'); 'c' is at its limit.
    expect(limiter.check('a', 1).allowed).toBe(true);
    expect(limiter.check('c', 1).allowed).toBe(false);
    expect(() => new WindowLimiter(0, 60)).toThrow(RangeError);
    expect(() => new WindowLimiter(1, 0)).toThrow(RangeError);
  });

  it('carries the limits fixed at S0', () => {
    const limits = defaultLimits();
    expect([SIGNUP_PER_ADDRESS, SIGNUP_PER_NETWORK, READS_PER_READER]).toEqual([3, 10, 600]);
    expect(limits.signupAddress.limit).toBe(3);
    expect(limits.signupNetwork.windowSeconds).toBe(900);
    expect(limits.readerReads.limit).toBe(600);
  });
});
