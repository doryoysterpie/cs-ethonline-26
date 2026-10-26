import 'server-only';

/**
 * A fixed-window counter per key, bounded in memory, for the limits CAS-007
 * fixes at S0 (report, section 1.6): sign-up requests per address and per
 * network source, and reads per reader account. Each decision says whether
 * the request may proceed, how long to wait otherwise, and whether this is
 * the first refusal of the window, so the caller writes one count-only audit
 * event per trip and never one per refused request.
 */
export interface LimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
  /** True on the request that first crosses the limit in this window. */
  readonly firstTrip: boolean;
}

interface Bucket {
  readonly windowStart: number;
  readonly count: number;
}

export class WindowLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    readonly limit: number,
    readonly windowSeconds: number,
    private readonly maxKeys = 10_000,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit');
    if (!Number.isInteger(windowSeconds) || windowSeconds < 1) throw new RangeError('window');
  }

  check(key: string, nowSeconds: number): LimitDecision {
    const current = this.buckets.get(key);
    const fresh = current === undefined || nowSeconds - current.windowStart >= this.windowSeconds;
    const next: Bucket = fresh
      ? { windowStart: nowSeconds, count: 1 }
      : { windowStart: current.windowStart, count: current.count + 1 };
    if (!this.buckets.has(key) && this.buckets.size >= this.maxKeys) {
      // Bounded memory: drop the oldest tracked key rather than grow without limit.
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    this.buckets.set(key, next);
    if (next.count <= this.limit) return { allowed: true, retryAfterSeconds: 0, firstTrip: false };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, next.windowStart + this.windowSeconds - nowSeconds),
      firstTrip: next.count === this.limit + 1,
    };
  }
}

/** The limits CAS-007 fixes at S0, each one window of fifteen minutes. */
export const LIMIT_WINDOW_SECONDS = 15 * 60;
export const SIGNUP_PER_ADDRESS = 3;
export const SIGNUP_PER_NETWORK = 10;
export const READS_PER_READER = 600;
/** Hosted-checkout hand-offs one account may start per window (CAS-008). */
export const CHECKOUTS_PER_ACCOUNT = 5;
/** Cards made per account in a window; a card that already exists is returned without spending one (D48, 7). */
export const CARDS_PER_ACCOUNT = 20;
/** Card pages and images served per network source in a window (D48, 5). */
export const CARD_VIEWS_PER_NETWORK = 300;

export interface Limits {
  readonly signupAddress: WindowLimiter;
  readonly signupNetwork: WindowLimiter;
  readonly readerReads: WindowLimiter;
  readonly checkoutAccount: WindowLimiter;
  readonly cardAccount: WindowLimiter;
  readonly cardNetwork: WindowLimiter;
}

export function defaultLimits(): Limits {
  return {
    signupAddress: new WindowLimiter(SIGNUP_PER_ADDRESS, LIMIT_WINDOW_SECONDS),
    signupNetwork: new WindowLimiter(SIGNUP_PER_NETWORK, LIMIT_WINDOW_SECONDS),
    readerReads: new WindowLimiter(READS_PER_READER, LIMIT_WINDOW_SECONDS),
    checkoutAccount: new WindowLimiter(CHECKOUTS_PER_ACCOUNT, LIMIT_WINDOW_SECONDS),
    cardAccount: new WindowLimiter(CARDS_PER_ACCOUNT, LIMIT_WINDOW_SECONDS),
    cardNetwork: new WindowLimiter(CARD_VIEWS_PER_NETWORK, LIMIT_WINDOW_SECONDS),
  };
}
