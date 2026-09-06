import { describe, expect, it } from 'vitest';

import { adaptStandardizedTvl, type AdapterContext } from './adapter.js';
import { GraphProbeError } from './errors.js';
import { TEST_SUBGRAPH_ID, T_NOW, snapshot, validPayload } from './test-support.js';

const ctx: AdapterContext = {
  subgraphId: TEST_SUBGRAPH_ID,
  chain: 'ethereum',
  slug: 'synthetic-lending',
  queriedAtUtc: new Date(T_NOW * 1000).toISOString(),
  queryDocumentSha256: 'deadbeef',
};

function kindOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof GraphProbeError) return error.kind;
    return 'not-a-probe-error';
  }
  return 'no-error';
}

describe('adaptStandardizedTvl', () => {
  it('adapts a valid standardized response into observations and live provenance', () => {
    const reading = adaptStandardizedTvl(validPayload(), ctx);
    expect(reading.protocol).toEqual({
      name: 'Synthetic Lending',
      slug: 'synthetic-lending',
      chain: 'ethereum',
    });
    expect(reading.reportedNetwork).toBe('MAINNET');
    expect(reading.observations).toHaveLength(5);
    expect(reading.observations.at(-1)).toMatchObject({
      source: 'protocol-head',
      totalValueLockedUsd: '1050.5',
    });
    expect(reading.provenance).toMatchObject({
      origin: 'live',
      provider: 'the-graph-gateway',
      subgraphId: TEST_SUBGRAPH_ID,
      deploymentId: 'QmSyntheticDeploymentIdForUnitTestsOnly000000000',
      chain: 'ethereum',
      queryDocumentSha256: 'deadbeef',
      block: { number: 25_000_000, hash: '0xabc123', timestamp: T_NOW },
      hasIndexingErrors: false,
      schemaVersion: '3.1.0',
      subgraphVersion: '9.9.9',
      methodologyVersion: '1.0.0',
    });
    expect(reading.provenance.snapshotTimestamps).toHaveLength(4);
  });

  it('keeps every raw TVL string unchanged', () => {
    const reading = adaptStandardizedTvl(validPayload(), ctx);
    expect(reading.observations.map((o) => o.totalValueLockedUsd)).toEqual([
      '1049.0',
      '1000.0',
      '990.0',
      '980.0',
      '1050.5',
    ]);
  });

  it('omits the head observation when the provider returns no block timestamp', () => {
    const payload = validPayload({
      _meta: { block: { number: 1, hash: null }, deployment: null, hasIndexingErrors: false },
    });
    const reading = adaptStandardizedTvl(payload, ctx);
    expect(reading.observations).toHaveLength(4);
    expect(reading.provenance.block.timestamp).toBeNull();
    expect(reading.provenance.deploymentId).toBeNull();
  });

  it('fails with kind "indexing" when hasIndexingErrors is true', () => {
    const payload = validPayload({
      _meta: {
        block: { number: 1, hash: '0x1', timestamp: T_NOW },
        deployment: 'Qm1',
        hasIndexingErrors: true,
      },
    });
    expect(kindOf(() => adaptStandardizedTvl(payload, ctx))).toBe('indexing');
  });

  it('fails with kind "schema" when a snapshot field is missing', () => {
    const missingTvl = validPayload({
      financialsDailySnapshots: [{ id: 'a', timestamp: String(T_NOW), blockNumber: '1' }],
    });
    expect(kindOf(() => adaptStandardizedTvl(missingTvl, ctx))).toBe('schema');
    const missingTimestamp = validPayload({
      financialsDailySnapshots: [{ id: 'a', blockNumber: '1', totalValueLockedUSD: '1' }],
    });
    expect(kindOf(() => adaptStandardizedTvl(missingTimestamp, ctx))).toBe('schema');
  });

  it('fails with kind "validation" when a TVL string is malformed', () => {
    const payload = validPayload({
      financialsDailySnapshots: [snapshot(1, 'abc'), snapshot(25, '1')],
    });
    expect(kindOf(() => adaptStandardizedTvl(payload, ctx))).toBe('validation');
  });

  it('never returns an empty success', () => {
    expect(
      kindOf(() => adaptStandardizedTvl(validPayload({ financialsDailySnapshots: [] }), ctx)),
    ).toBe('schema');
    expect(kindOf(() => adaptStandardizedTvl(validPayload({ protocols: [] }), ctx))).toBe('schema');
    expect(kindOf(() => adaptStandardizedTvl(validPayload({ _meta: undefined }), ctx))).toBe(
      'schema',
    );
    expect(kindOf(() => adaptStandardizedTvl(null, ctx))).toBe('schema');
  });
});
