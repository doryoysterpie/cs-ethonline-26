import { describe, expect, it } from 'vitest';

import { adaptStandardizedTvl } from './adapter.js';
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  FRESHNESS_LIMIT_SECONDS,
  evaluateFreshness,
} from './freshness.js';
import { evaluateTarget, type DeploymentTarget } from './gate.js';
import {
  TEST_SUBGRAPH_ID,
  T_NOW,
  snapshot,
  validPayload,
  type SnapshotShape,
} from './test-support.js';

const target: DeploymentTarget = {
  label: 'synthetic-lending',
  chain: 'ethereum',
  protocol: 'Synthetic Lending',
  slug: 'synthetic-lending',
  expectedProviderSlug: 'synthetic-lending',
  subgraphId: TEST_SUBGRAPH_ID,
  schemaFamily: 'lending',
  expected: { network: 'MAINNET', protocolType: 'LENDING', schemaVersion: '3.1.0' },
};

function evaluateWithHeadTimestamp(headTimestamp: number, snapshots?: SnapshotShape[]) {
  const payload = validPayload({
    _meta: {
      block: { number: 25_000_000, hash: '0xabc', timestamp: headTimestamp },
      deployment: 'QmSyntheticDeploymentIdForUnitTestsOnly000000000',
      hasIndexingErrors: false,
    },
    ...(snapshots ? { financialsDailySnapshots: snapshots } : {}),
  });
  const reading = adaptStandardizedTvl(payload, {
    subgraphId: TEST_SUBGRAPH_ID,
    targetChain: 'ethereum',
    targetSlug: 'synthetic-lending',
    queriedAtUtc: new Date(T_NOW * 1000).toISOString(),
    queryDocumentSha256: 'deadbeef',
    provider: 'the-graph-gateway',
    providerBase: 'https://gateway.thegraph.com/api',
  });
  return evaluateTarget(target, reading, T_NOW, (s) => s);
}

describe('evaluateFreshness', () => {
  it('accepts an observation up to the freshness limit and rejects one past it', () => {
    expect(evaluateFreshness(T_NOW, T_NOW).reason).toBe('fresh');
    expect(evaluateFreshness(T_NOW, T_NOW - FRESHNESS_LIMIT_SECONDS).reason).toBe('fresh');
    const stale = evaluateFreshness(T_NOW, T_NOW - FRESHNESS_LIMIT_SECONDS - 1);
    expect(stale.fresh).toBe(false);
    expect(stale.reason).toBe('stale');
    expect(stale.ageSeconds).toBe(FRESHNESS_LIMIT_SECONDS + 1);
  });

  it('accepts a future timestamp inside the documented clock-skew tolerance', () => {
    const inside = evaluateFreshness(T_NOW, T_NOW + CLOCK_SKEW_TOLERANCE_SECONDS);
    expect(inside.fresh).toBe(true);
    expect(inside.reason).toBe('fresh');
    expect(inside.ageSeconds).toBe(-CLOCK_SKEW_TOLERANCE_SECONDS);
  });

  it('rejects a future timestamp beyond the tolerance; a negative age never passes as fresh by accident', () => {
    const outside = evaluateFreshness(T_NOW, T_NOW + CLOCK_SKEW_TOLERANCE_SECONDS + 1);
    expect(outside.fresh).toBe(false);
    expect(outside.reason).toBe('future');
    expect(outside.ageSeconds).toBe(-(CLOCK_SKEW_TOLERANCE_SECONDS + 1));
  });
});

describe('freshness inside target evaluation', () => {
  it('fails a target whose current observation is dated beyond the skew tolerance', () => {
    const evaluation = evaluateWithHeadTimestamp(T_NOW + CLOCK_SKEW_TOLERANCE_SECONDS + 1);
    expect(evaluation.valid).toBe(false);
    expect(evaluation.failure?.message).toMatch(/freshness: future/);
    expect(evaluation.freshness?.reason).toBe('future');
  });

  it('accepts a target whose current observation is inside the skew tolerance', () => {
    const evaluation = evaluateWithHeadTimestamp(T_NOW + CLOCK_SKEW_TOLERANCE_SECONDS);
    expect(evaluation.valid).toBe(true);
    expect(evaluation.freshness?.reason).toBe('fresh');
    expect(evaluation.freshness?.ageSeconds).toBe(-CLOCK_SKEW_TOLERANCE_SECONDS);
  });

  it('fails a target whose newest observation is stale', () => {
    // Head 49 h old, snapshots older still: the newest observation is past the limit.
    const evaluation = evaluateWithHeadTimestamp(T_NOW - FRESHNESS_LIMIT_SECONDS - 3600, [
      snapshot(50, '1000.0'),
      snapshot(74, '990.0'),
    ]);
    expect(evaluation.valid).toBe(false);
    expect(evaluation.freshness?.reason).toBe('stale');
    expect(evaluation.failure?.message).toMatch(/freshness: stale/);
  });
});
