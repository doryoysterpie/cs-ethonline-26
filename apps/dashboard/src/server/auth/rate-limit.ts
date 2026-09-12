import 'server-only';

/**
 * Login throttling by account and by network source.
 *
 * Two independent limits, both keyed on what the request submitted rather
 * than on what exists: the account key is the submitted username whether or
 * not an account by that name exists, so a throttled answer says nothing
 * about existence. A successful sign-in clears the account's failure count;
 * nothing clears a network's count except time.
 *
 * Process-local. A deployment with several processes shares no state here;
 * that is a named seam for the PostgreSQL store to close.
 */

export const ACCOUNT_FAILURE_LIMIT = 5;
export const NETWORK_ATTEMPT_LIMIT = 30;
export const WINDOW_SECONDS = 15 * 60;
const MAX_TRACKED_KEYS = 10_000;

interface Bucket {
  readonly windowStart: number;
  readonly count: number;
}

export type ThrottleDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'account' | 'network';
      readonly retryAfterSeconds: number;
    };

function bump(map: Map<string, Bucket>, key: string, now: number): Bucket {
  const current = map.get(key);
  const next =
    current === undefined || now - current.windowStart >= WINDOW_SECONDS
      ? { windowStart: now, count: 1 }
      : { windowStart: current.windowStart, count: current.count + 1 };
  if (!map.has(key) && map.size >= MAX_TRACKED_KEYS) {
    // Bounded memory: drop the oldest tracked key rather than grow without limit.
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, next);
  return next;
}

function remaining(bucket: Bucket | undefined, now: number): number {
  if (bucket === undefined) return 0;
  return Math.max(0, bucket.windowStart + WINDOW_SECONDS - now);
}

export class LoginThrottle {
  private readonly accounts = new Map<string, Bucket>();
  private readonly networks = new Map<string, Bucket>();

  /** Decides before a password is verified; counts the network attempt either way. */
  check(accountKey: string, networkKey: string, nowSeconds: number): ThrottleDecision {
    const network = bump(this.networks, networkKey, nowSeconds);
    if (network.count > NETWORK_ATTEMPT_LIMIT) {
      return {
        allowed: false,
        reason: 'network',
        retryAfterSeconds: remaining(network, nowSeconds),
      };
    }
    const account = this.accounts.get(accountKey);
    if (
      account !== undefined &&
      nowSeconds - account.windowStart < WINDOW_SECONDS &&
      account.count >= ACCOUNT_FAILURE_LIMIT
    ) {
      return {
        allowed: false,
        reason: 'account',
        retryAfterSeconds: remaining(account, nowSeconds),
      };
    }
    return { allowed: true };
  }

  recordFailure(accountKey: string, nowSeconds: number): void {
    bump(this.accounts, accountKey, nowSeconds);
  }

  recordSuccess(accountKey: string): void {
    this.accounts.delete(accountKey);
  }
}
