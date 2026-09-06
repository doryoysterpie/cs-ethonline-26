import type {
  GraphQueryProvenance,
  ProtocolIdentity,
  ProtocolTvlObservation,
} from '@cas/contracts';
import { describe, expect, it } from 'vitest';

import { formatScaled, parseDecimal, parsePositiveDecimal } from './decimal.js';
import { GraphProbeError } from './errors.js';
import { HOUR, T_NOW } from './test-support.js';
import { DEFAULT_WINDOW, calculateTvlDelta, describeElapsed } from './tvl-delta.js';

const protocol: ProtocolIdentity = {
  name: 'Synthetic Lending',
  slug: 'synthetic-lending',
  chain: 'ethereum',
};
const provenance: GraphQueryProvenance = {
  origin: 'live',
  provider: 'the-graph-gateway',
  subgraphId: 'JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk',
  deploymentId: null,
  chain: 'ethereum',
  queriedAtUtc: new Date(T_NOW * 1000).toISOString(),
  queryDocumentSha256: 'deadbeef',
  block: { number: 1, hash: null, timestamp: T_NOW },
  snapshotTimestamps: [],
  hasIndexingErrors: false,
  schemaVersion: '3.1.0',
  subgraphVersion: null,
  methodologyVersion: null,
};

function obs(ageHours: number, tvl: string): ProtocolTvlObservation {
  return {
    timestamp: T_NOW - Math.round(ageHours * HOUR),
    blockNumber: null,
    totalValueLockedUsd: tvl,
    source: 'financials-daily-snapshot',
    snapshotId: null,
  };
}

describe('calculateTvlDelta', () => {
  it('computes an exact percentage delta against the observation closest to 24 h', () => {
    const signal = calculateTvlDelta({
      protocol,
      provenance,
      observations: [obs(0, '1050.5'), obs(25, '1000.0'), obs(49, '990.0')],
    });
    expect(signal.baseline.totalValueLockedUsd).toBe('1000.0');
    expect(signal.elapsedSeconds).toBe(25 * HOUR);
    expect(signal.deltaUsd).toBe('50.5');
    // 50.5 / 1000 * 100 = 5.05 exactly; six truncated fraction digits.
    expect(signal.deltaPercent).toBe('5.050000');
    expect(signal.window).toEqual(DEFAULT_WINDOW);
    expect(signal.provenance.origin).toBe('live');
  });

  it('orders observations by timestamp rather than trusting response order', () => {
    const shuffled = [obs(49, '990.0'), obs(0, '1050.5'), obs(25, '1000.0')];
    const signal = calculateTvlDelta({ protocol, provenance, observations: shuffled });
    expect(signal.current.totalValueLockedUsd).toBe('1050.5');
    expect(signal.baseline.totalValueLockedUsd).toBe('1000.0');
  });

  it('reports the measured elapsed window instead of assuming 24 h', () => {
    const signal = calculateTvlDelta({
      protocol,
      provenance,
      observations: [obs(0, '2'), obs(20, '1')],
    });
    expect(signal.elapsedSeconds).toBe(20 * HOUR);
    expect(describeElapsed(signal.elapsedSeconds)).toBe('20h 00m');
    expect(signal.deltaPercent).toBe('100.000000');
  });

  it('fails when no observation falls inside the baseline window', () => {
    expect(() =>
      calculateTvlDelta({
        protocol,
        provenance,
        observations: [obs(0, '2'), obs(2, '1'), obs(80, '1')],
      }),
    ).toThrowError(GraphProbeError);
    try {
      calculateTvlDelta({ protocol, provenance, observations: [obs(0, '2'), obs(2, '1')] });
    } catch (error) {
      expect(error).toBeInstanceOf(GraphProbeError);
      expect((error as GraphProbeError).kind).toBe('validation');
    }
  });

  it('rejects a zero baseline explicitly', () => {
    expect(() =>
      calculateTvlDelta({ protocol, provenance, observations: [obs(0, '5'), obs(24, '0')] }),
    ).toThrow(/is zero/);
  });

  it('rejects negative, non-finite, empty or malformed values', () => {
    for (const bad of ['-1', 'NaN', 'Infinity', '', '1e5', '1,000', '0x10', ' ']) {
      expect(() =>
        calculateTvlDelta({ protocol, provenance, observations: [obs(0, bad), obs(24, '1')] }),
      ).toThrowError(GraphProbeError);
    }
  });

  it('rejects an invalid timestamp', () => {
    const broken = { ...obs(24, '1'), timestamp: Number.NaN };
    expect(() =>
      calculateTvlDelta({ protocol, provenance, observations: [obs(0, '2'), broken] }),
    ).toThrow(/invalid timestamp/);
  });

  it('requires at least two observations', () => {
    expect(() => calculateTvlDelta({ protocol, provenance, observations: [obs(0, '1')] })).toThrow(
      /at least two/,
    );
  });

  it('truncates rather than rounds the percentage and keeps the raw strings', () => {
    const signal = calculateTvlDelta({
      protocol,
      provenance,
      observations: [obs(0, '1.0000000000000002'), obs(24, '3')],
    });
    expect(signal.current.totalValueLockedUsd).toBe('1.0000000000000002');
    expect(signal.deltaUsd).toBe('-1.9999999999999998');
    // -1.9999999999999998 / 3 * 100 = -66.66666666666666 → truncated to six digits.
    expect(signal.deltaPercent).toBe('-66.666666');
  });
});

describe('decimal helpers', () => {
  it('parses plain decimals exactly', () => {
    expect(parseDecimal('24773571335.52', 'x')).toEqual({ value: 2477357133552n, scale: 2 });
    expect(parseDecimal('7', 'x')).toEqual({ value: 7n, scale: 0 });
  });

  it('formats scaled integers with a fixed number of fraction digits', () => {
    expect(formatScaled(5050000n, 6)).toBe('5.050000');
    expect(formatScaled(-5n, 3)).toBe('-0.005');
    expect(formatScaled(0n, 0)).toBe('0');
  });

  it('rejects zero through parsePositiveDecimal', () => {
    expect(() => parsePositiveDecimal('0.000', 'x')).toThrow(/is zero/);
  });
});
