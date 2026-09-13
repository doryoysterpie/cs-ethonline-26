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
 * `LoginThrottle` below is process-local, used by the memory store: a
 * deployment of several processes shares no state through it. The
 * PostgreSQL store's throttle (`apps/dashboard/src/server/auth/postgres-store.ts`)
 * implements the same `Throttle` shape over a shared table instead, which is
 * what makes the limit hold across every application instance.
 */

/**
 * The shape `SessionService` calls through. `LoginThrottle` satisfies it
 * synchronously; a store-backed throttle satisfies it by returning promises.
 * `SessionService` always awaits, so either implementation works unchanged.
 */
export interface Throttle {
  check(
    accountKey: string,
    networkKey: string,
    nowSeconds: number,
  ): ThrottleDecision | Promise<ThrottleDecision>;
  recordFailure(accountKey: string, nowSeconds: number): void | Promise<void>;
  recordSuccess(accountKey: string): void | Promise<void>;
}

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

export class LoginThrottle implements Throttle {
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
