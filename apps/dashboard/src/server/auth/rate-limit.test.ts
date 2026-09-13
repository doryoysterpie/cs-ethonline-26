import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_FAILURE_LIMIT,
  LoginThrottle,
  NETWORK_ATTEMPT_LIMIT,
  WINDOW_SECONDS,
} from './rate-limit.ts';

describe('login throttle', () => {
  it('blocks an account after the failure limit and clears on success', () => {
    const throttle = new LoginThrottle();
    for (let attempt = 0; attempt < ACCOUNT_FAILURE_LIMIT; attempt += 1) {
      expect(throttle.check('account:syn', 'network:direct', 1000 + attempt)).toEqual({
        allowed: true,
      });
      throttle.recordFailure('account:syn', 1000 + attempt);
    }
    const blocked = throttle.check('account:syn', 'network:direct', 1010);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.reason).toBe('account');
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    }
    throttle.recordSuccess('account:syn');
    expect(throttle.check('account:syn', 'network:direct', 1011)).toEqual({ allowed: true });
  });

  it('treats an unknown and a known account name the same way', () => {
    const throttle = new LoginThrottle();
    for (const key of ['account:exists', 'account:nope']) {
      for (let attempt = 0; attempt < ACCOUNT_FAILURE_LIMIT; attempt += 1) {
        throttle.check(key, 'network:direct', 100);
        throttle.recordFailure(key, 100);
      }
    }
    const a = throttle.check('account:exists', 'network:direct', 101);
    const b = throttle.check('account:nope', 'network:direct', 101);
    expect(a).toEqual(b);
  });

  it('blocks a network source after the attempt limit regardless of account', () => {
    const throttle = new LoginThrottle();
    for (let attempt = 0; attempt < NETWORK_ATTEMPT_LIMIT; attempt += 1) {
      expect(throttle.check(`account:user${attempt}`, 'network:10.0.0.1', 500).allowed).toBe(true);
    }
    const blocked = throttle.check('account:fresh', 'network:10.0.0.1', 501);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.reason).toBe('network');
    expect(throttle.check('account:fresh', 'network:10.0.0.2', 501).allowed).toBe(true);
  });

  it('forgets after the window', () => {
    const throttle = new LoginThrottle();
    for (let attempt = 0; attempt < ACCOUNT_FAILURE_LIMIT; attempt += 1) {
      throttle.recordFailure('account:syn', 100);
    }
    expect(throttle.check('account:syn', 'network:direct', 101).allowed).toBe(false);
    expect(throttle.check('account:syn', 'network:direct', 100 + WINDOW_SECONDS).allowed).toBe(
      true,
    );
  });
});
