import type {
  GraphQueryProvenance,
  ProtocolIdentity,
  ProtocolTvlObservation,
  TvlDeltaSignal,
} from '@cas/contracts';

import { formatScaled, parsePositiveDecimal, rescale } from './decimal.js';
import { GraphProbeError } from './errors.js';

/**
 * Baseline window rule. The baseline is the observation whose age relative to
 * the current observation is closest to the 24 h target, among observations
 * aged between the minimum and maximum. The measured elapsed time is always
 * reported; an elapsed time inside the window is never described as 24 h.
 */
export const DEFAULT_WINDOW = {
  targetSeconds: 24 * 3600,
  minSeconds: 12 * 3600,
  maxSeconds: 48 * 3600,
} as const;

/** Percentage precision: six fraction digits, truncated toward zero, not rounded. */
export const PERCENT_FRACTION_DIGITS = 6;

export interface TvlDeltaInput {
  readonly protocol: ProtocolIdentity;
  readonly observations: readonly ProtocolTvlObservation[];
  readonly provenance: GraphQueryProvenance;
  readonly window?: typeof DEFAULT_WINDOW;
}

function assertObservation(o: ProtocolTvlObservation, index: number): void {
  if (!Number.isFinite(o.timestamp) || !Number.isInteger(o.timestamp) || o.timestamp <= 0) {
    throw new GraphProbeError('validation', `observation ${index} has an invalid timestamp`, {
      timestamp: o.timestamp,
    });
  }
  parsePositiveDecimal(o.totalValueLockedUsd, `observation ${index} totalValueLockedUsd`);
}

/**
 * Deterministic TVL-delta calculation.
 *
 * 1. Every observation is validated: integer positive timestamp, positive
 *    plain-decimal TVL. Zero, negative, missing, non-finite or malformed
 *    values are rejected explicitly.
 * 2. Observations are sorted by timestamp ascending; response order is never
 *    trusted. Equal timestamps keep a stable order and the later entry wins
 *    as "current" only if it is strictly newer.
 * 3. The current observation is the newest. The baseline is chosen by the
 *    window rule above. If no observation falls inside the window, the
 *    calculation fails rather than stretching the window.
 * 4. Delta and percentage are computed exactly with scaled BigInt
 *    arithmetic. The percentage is truncated to six fraction digits; that
 *    truncation is the only precision loss and the raw strings are retained.
 */
export function calculateTvlDelta(input: TvlDeltaInput): TvlDeltaSignal {
  const window = input.window ?? DEFAULT_WINDOW;
  if (input.observations.length < 2) {
    throw new GraphProbeError('validation', 'at least two observations are required', {
      count: input.observations.length,
    });
  }
  input.observations.forEach(assertObservation);

  const sorted = [...input.observations].sort((a, b) => a.timestamp - b.timestamp);
  const current = sorted[sorted.length - 1];
  if (current === undefined) {
    throw new GraphProbeError('validation', 'no current observation');
  }

  let baseline: ProtocolTvlObservation | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of sorted.slice(0, -1)) {
    const elapsed = current.timestamp - candidate.timestamp;
    if (elapsed < window.minSeconds || elapsed > window.maxSeconds) continue;
    const distance = Math.abs(elapsed - window.targetSeconds);
    if (distance < bestDistance) {
      bestDistance = distance;
      baseline = candidate;
    }
  }
  if (baseline === undefined) {
    throw new GraphProbeError(
      'validation',
      `no baseline observation between ${window.minSeconds} s and ${window.maxSeconds} s before the current observation`,
      {
        currentTimestamp: current.timestamp,
        candidateTimestamps: sorted.slice(0, -1).map((o) => o.timestamp),
      },
    );
  }

  const cur = parsePositiveDecimal(current.totalValueLockedUsd, 'current totalValueLockedUsd');
  const base = parsePositiveDecimal(baseline.totalValueLockedUsd, 'baseline totalValueLockedUsd');
  const scale = Math.max(cur.scale, base.scale);
  const curScaled = rescale(cur, scale);
  const baseScaled = rescale(base, scale);
  const deltaScaled = curScaled - baseScaled;

  // percent = delta / base * 100, kept as an integer with PERCENT_FRACTION_DIGITS
  // fraction digits. BigInt division truncates toward zero.
  const percentScaled = (deltaScaled * 100n * 10n ** BigInt(PERCENT_FRACTION_DIGITS)) / baseScaled;

  return {
    protocol: input.protocol,
    current,
    baseline,
    elapsedSeconds: current.timestamp - baseline.timestamp,
    window: {
      targetSeconds: window.targetSeconds,
      minSeconds: window.minSeconds,
      maxSeconds: window.maxSeconds,
    },
    deltaUsd: formatScaled(deltaScaled, scale),
    deltaPercent: formatScaled(percentScaled, PERCENT_FRACTION_DIGITS),
    provenance: input.provenance,
  };
}

/** Human-readable elapsed window, never rounded up to a whole day. */
export function describeElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
}
