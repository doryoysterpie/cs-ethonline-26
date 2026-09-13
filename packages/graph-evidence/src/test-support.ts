/**
 * Synthetic payload builders for unit tests. Every value here is invented;
 * nothing is copied from a live provider response. These helpers are test
 * support only and are excluded from the built package by tsconfig.build.json.
 */

export const TEST_SUBGRAPH_ID = 'JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk';
export const TEST_KEY = 'unit-test-key-0123456789abcdef';

/** Unix seconds for a fixed synthetic "now": 2026-09-06T01:00:00Z. */
export const T_NOW = 1788656400;
export const HOUR = 3600;

export interface SnapshotShape {
  id: string;
  timestamp: string;
  blockNumber: string;
  totalValueLockedUSD: string;
}

export function snapshot(ageHours: number, tvl: string, id = `snap-${ageHours}`): SnapshotShape {
  return {
    id,
    timestamp: String(T_NOW - Math.round(ageHours * HOUR)),
    blockNumber: String(25_000_000 - Math.round(ageHours * 300)),
    totalValueLockedUSD: tvl,
  };
}

export function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _meta: {
      block: { number: 25_000_000, hash: '0xabc123', timestamp: T_NOW },
      deployment: 'QmSyntheticDeploymentIdForUnitTestsOnly000000000',
      hasIndexingErrors: false,
    },
    protocols: [
      {
        id: '0x0000000000000000000000000000000000000001',
        name: 'Synthetic Lending',
        slug: 'synthetic-lending',
        network: 'MAINNET',
        type: 'LENDING',
        schemaVersion: '3.1.0',
        subgraphVersion: '9.9.9',
        methodologyVersion: '1.0.0',
        totalValueLockedUSD: '1050.5',
      },
    ],
    financialsDailySnapshots: [
      snapshot(1, '1049.0'),
      snapshot(25, '1000.0'),
      snapshot(49, '990.0'),
      snapshot(73, '980.0'),
    ],
    ...overrides,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
