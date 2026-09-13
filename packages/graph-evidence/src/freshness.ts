/**
 * Freshness rule for the current observation, evaluated against the UTC time
 * the query was issued.
 *
 * - An observation older than FRESHNESS_LIMIT_SECONDS is stale.
 * - An observation dated in the future is rejected once it is more than
 *   CLOCK_SKEW_TOLERANCE_SECONDS ahead of the query time. Inside the
 *   tolerance it is accepted as fresh, because block timestamps and the local
 *   clock can legitimately disagree by a few seconds. The measured age is
 *   always reported, negative when the observation leads the clock.
 */
export const FRESHNESS_LIMIT_SECONDS = 48 * 3600;
export const CLOCK_SKEW_TOLERANCE_SECONDS = 120;

export interface FreshnessResult {
  /** Query time minus observation time, in seconds. Negative means the observation is ahead. */
  readonly ageSeconds: number;
  readonly fresh: boolean;
  readonly reason: 'fresh' | 'stale' | 'future';
  readonly limitSeconds: number;
  readonly skewToleranceSeconds: number;
}

export function evaluateFreshness(
  queriedAtSeconds: number,
  observationTimestamp: number,
  limitSeconds: number = FRESHNESS_LIMIT_SECONDS,
  skewToleranceSeconds: number = CLOCK_SKEW_TOLERANCE_SECONDS,
): FreshnessResult {
  const ageSeconds = queriedAtSeconds - observationTimestamp;
  let reason: FreshnessResult['reason'] = 'fresh';
  if (ageSeconds < -skewToleranceSeconds) reason = 'future';
  else if (ageSeconds > limitSeconds) reason = 'stale';
  return {
    ageSeconds,
    fresh: reason === 'fresh',
    reason,
    limitSeconds,
    skewToleranceSeconds,
  };
}
