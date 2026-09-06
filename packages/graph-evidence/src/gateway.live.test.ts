import { describe, expect, it } from 'vitest';

import { GraphGatewayClient } from './client.js';
import {
  BASE_LENDING_TARGETS,
  ETHEREUM_GATE_MINIMUM_PROTOCOLS,
  ETHEREUM_LENDING_TARGETS,
} from './deployments.js';
import { calculateTvlDelta, describeElapsed } from './tvl-delta.js';

/**
 * Live integration test. Runs only through `pnpm --filter @cas/graph-evidence test:live`.
 * Requires GRAPH_API_KEY in the environment and performs real gateway queries.
 * It fails, rather than skips, without the credential, so that a missing key
 * can never look like a pass.
 */
describe('live gateway integration', () => {
  const apiKey = process.env['GRAPH_API_KEY'];

  it('has a credential', () => {
    expect(apiKey, 'GRAPH_API_KEY must be exported for the live integration test').toBeTruthy();
  });

  it('passes the Ethereum proof gate with the one common query', async () => {
    const client = new GraphGatewayClient({
      apiKey,
      gatewayBaseUrl: process.env['GRAPH_GATEWAY_URL'],
    });
    const protocols = new Set<string>();
    for (const target of ETHEREUM_LENDING_TARGETS) {
      const reading = await client.queryStandardizedTvl({
        subgraphId: target.subgraphId,
        chain: target.chain,
        slug: target.slug,
      });
      expect(reading.provenance.origin).toBe('live');
      expect(reading.provenance.hasIndexingErrors).toBe(false);
      expect(reading.provenance.block.number).toBeGreaterThan(0);
      expect(reading.reportedNetwork).toBe('MAINNET');
      const signal = calculateTvlDelta({
        protocol: reading.protocol,
        observations: reading.observations,
        provenance: reading.provenance,
      });
      console.log(
        `[live] ${target.protocol}: block ${signal.provenance.block.number}, elapsed ${describeElapsed(signal.elapsedSeconds)}, delta ${signal.deltaPercent}%`,
      );
      protocols.add(target.protocol);
    }
    expect(protocols.size).toBeGreaterThanOrEqual(ETHEREUM_GATE_MINIMUM_PROTOCOLS);
  });

  it('reports the Base secondary chain without affecting the Ethereum gate', async () => {
    const client = new GraphGatewayClient({
      apiKey,
      gatewayBaseUrl: process.env['GRAPH_GATEWAY_URL'],
    });
    for (const target of BASE_LENDING_TARGETS) {
      const reading = await client.queryStandardizedTvl({
        subgraphId: target.subgraphId,
        chain: target.chain,
        slug: target.slug,
      });
      expect(reading.reportedNetwork).toBe('BASE');
      const signal = calculateTvlDelta({
        protocol: reading.protocol,
        observations: reading.observations,
        provenance: reading.provenance,
      });
      console.log(
        `[live] ${target.protocol} (base): block ${signal.provenance.block.number}, elapsed ${describeElapsed(signal.elapsedSeconds)}, delta ${signal.deltaPercent}%`,
      );
    }
  });
});
