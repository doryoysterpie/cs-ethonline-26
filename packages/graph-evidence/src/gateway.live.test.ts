import { describe, expect, it } from 'vitest';

import { GraphGatewayClient } from './client.js';
import {
  BASE_GATE_MINIMUM_PROTOCOLS,
  BASE_LENDING_TARGETS,
  ETHEREUM_GATE_MINIMUM_PROTOCOLS,
  ETHEREUM_LENDING_TARGETS,
} from './deployments.js';
import {
  evaluateChainGate,
  evaluateFailedTarget,
  evaluateTarget,
  type DeploymentTarget,
  type TargetEvaluation,
} from './gate.js';
import { formatEvaluation, formatGate } from './probe.js';

/**
 * Live integration test. Runs only through `corepack pnpm graph:test:live`.
 * Requires GRAPH_API_KEY in the environment and performs real gateway queries.
 * It fails, rather than skips, without the credential, so that a missing key
 * can never look like a pass. Every count comes from the corrected gate,
 * which validates provider-returned identity against the registry, and every
 * printed line goes through the redacting, single-line formatter.
 */
describe('live gateway integration', () => {
  const apiKey = process.env['GRAPH_API_KEY'];

  it('has a credential', () => {
    expect(apiKey, 'GRAPH_API_KEY must be exported for the live integration test').toBeTruthy();
  });

  async function evaluateAll(targets: readonly DeploymentTarget[]): Promise<{
    evaluations: TargetEvaluation[];
    client: GraphGatewayClient;
  }> {
    const client = new GraphGatewayClient({
      apiKey,
      gatewayBaseUrl: process.env['GRAPH_GATEWAY_URL'],
    });
    const evaluations: TargetEvaluation[] = [];
    for (const target of targets) {
      try {
        const reading = await client.queryStandardizedTvl({
          subgraphId: target.subgraphId,
          targetChain: target.chain,
          targetSlug: target.slug,
        });
        const queriedAt = Math.floor(Date.parse(reading.provenance.queriedAtUtc) / 1000);
        evaluations.push(evaluateTarget(target, reading, queriedAt, client.redact));
      } catch (error) {
        evaluations.push(evaluateFailedTarget(target, error, client.redact));
      }
      const last = evaluations.at(-1);
      if (last) console.log(formatEvaluation(last, client.redact));
    }
    return { evaluations, client };
  }

  it('passes the Ethereum proof gate on verified provider identities', async () => {
    const { evaluations, client } = await evaluateAll(ETHEREUM_LENDING_TARGETS);
    const gate = evaluateChainGate(evaluations, {
      chain: 'ethereum',
      minimum: ETHEREUM_GATE_MINIMUM_PROTOCOLS,
      requireAll: false,
    });
    console.log(formatGate('[live] Ethereum gate', gate, 'PASS', 'FAIL', client.redact));
    for (const e of evaluations) {
      expect(
        e.failure?.kind,
        `${e.target.label}: ${client.redact(e.failure?.message ?? '')}`,
      ).not.toBe('unexpected');
    }
    expect(gate.passed, client.redact(gate.reasons.join(' | '))).toBe(true);
    expect(gate.distinctIdentities).toBeGreaterThanOrEqual(ETHEREUM_GATE_MINIMUM_PROTOCOLS);
    expect(gate.distinctDeploymentIds).toBeGreaterThanOrEqual(ETHEREUM_GATE_MINIMUM_PROTOCOLS);
  });

  it('passes the strict all-targets Base gate, as D18 and D19 record Base as kept', async () => {
    const { evaluations, client } = await evaluateAll(BASE_LENDING_TARGETS);
    const gate = evaluateChainGate(evaluations, {
      chain: 'base',
      minimum: BASE_GATE_MINIMUM_PROTOCOLS,
      requireAll: true,
    });
    console.log(formatGate('[live] Base secondary', gate, 'PASS/KEEP', 'FAIL/DROP', client.redact));
    for (const e of evaluations) {
      expect(
        e.failure?.kind,
        `${e.target.label}: ${client.redact(e.failure?.message ?? '')}`,
      ).not.toBe('unexpected');
    }
    expect(gate.configured).toBe(BASE_LENDING_TARGETS.length);
    // Base is recorded as KEPT. If this assertion fails, do not weaken it:
    // record Base as FAIL/DROP, supersede the keep in DECISIONS.md and update
    // this expectation together with the documentation.
    expect(gate.passed, `Base FAIL/DROP: ${client.redact(gate.reasons.join(' | '))}`).toBe(true);
    expect(gate.distinctIdentities).toBe(BASE_GATE_MINIMUM_PROTOCOLS);
  });
});
