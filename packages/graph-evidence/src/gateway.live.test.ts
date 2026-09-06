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
 * which validates provider-returned identity against the registry.
 */
describe('live gateway integration', () => {
  const apiKey = process.env['GRAPH_API_KEY'];

  it('has a credential', () => {
    expect(apiKey, 'GRAPH_API_KEY must be exported for the live integration test').toBeTruthy();
  });

  async function evaluateAll(targets: readonly DeploymentTarget[]): Promise<TargetEvaluation[]> {
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
      if (last) console.log(formatEvaluation(last));
    }
    return evaluations;
  }

  it('passes the Ethereum proof gate on verified provider identities', async () => {
    const evaluations = await evaluateAll(ETHEREUM_LENDING_TARGETS);
    const gate = evaluateChainGate(evaluations, {
      chain: 'ethereum',
      minimum: ETHEREUM_GATE_MINIMUM_PROTOCOLS,
      requireAll: false,
    });
    console.log(formatGate('[live] Ethereum gate', gate, 'PASS', 'FAIL'));
    for (const e of evaluations) {
      expect(e.failure?.kind, `${e.target.label}: ${e.failure?.message ?? ''}`).not.toBe(
        'unexpected',
      );
    }
    expect(gate.passed, gate.reasons.join(' | ')).toBe(true);
    expect(gate.distinctIdentities).toBeGreaterThanOrEqual(ETHEREUM_GATE_MINIMUM_PROTOCOLS);
    expect(gate.distinctDeploymentIds).toBeGreaterThanOrEqual(ETHEREUM_GATE_MINIMUM_PROTOCOLS);
  });

  it('evaluates the Base secondary chain with the strict all-targets rule and reports truthfully', async () => {
    const evaluations = await evaluateAll(BASE_LENDING_TARGETS);
    const gate = evaluateChainGate(evaluations, {
      chain: 'base',
      minimum: BASE_GATE_MINIMUM_PROTOCOLS,
      requireAll: true,
    });
    console.log(formatGate('[live] Base secondary', gate, 'PASS/KEEP', 'FAIL/DROP'));
    // Every Base outcome must be a structured, classified result; the keep/drop
    // verdict itself is recorded in the report and never affects the exit contract.
    for (const e of evaluations) {
      expect(e.valid || (e.failure !== null && e.failure.kind !== 'unexpected')).toBe(true);
    }
    expect(gate.configured).toBe(BASE_LENDING_TARGETS.length);
  });
});
