import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TvlDeltaSignal } from '@cas/contracts';

import { GraphGatewayClient } from './client.js';
import {
  BASE_LENDING_TARGETS,
  ETHEREUM_GATE_MINIMUM_PROTOCOLS,
  ETHEREUM_LENDING_TARGETS,
  type DeploymentTarget,
} from './deployments.js';
import { GraphProbeError, isGraphProbeError } from './errors.js';
import { queryDocumentSha256 } from './query.js';
import { createRedactor } from './redact.js';
import { calculateTvlDelta, describeElapsed } from './tvl-delta.js';

/**
 * Sprint 1 live probe. Runs the common standardized query against every
 * selected deployment, computes the TVL-delta signal, prints a concise
 * redacted summary, and writes details under the ignored `output/` path.
 *
 * Exit codes: 0 Ethereum gate passed; 1 Ethereum gate failed; 2 credential
 * missing or configuration invalid. Base is reported but never changes the
 * exit code. There is no fixture or replay path in this program.
 */

/** Data older than this, measured from the query time to the current observation, fails freshness. */
export const FRESHNESS_LIMIT_SECONDS = 48 * 3600;

interface ProbeOutcome {
  readonly target: DeploymentTarget;
  readonly signal: TvlDeltaSignal | null;
  readonly reportedNetwork: string | null;
  readonly freshnessSeconds: number | null;
  readonly failure: { kind: string; message: string } | null;
}

async function probeTarget(
  client: GraphGatewayClient,
  target: DeploymentTarget,
): Promise<ProbeOutcome> {
  try {
    const reading = await client.queryStandardizedTvl({
      subgraphId: target.subgraphId,
      chain: target.chain,
      slug: target.slug,
    });
    const signal = calculateTvlDelta({
      protocol: reading.protocol,
      observations: reading.observations,
      provenance: reading.provenance,
    });
    const queriedAt = Math.floor(Date.parse(reading.provenance.queriedAtUtc) / 1000);
    const freshnessSeconds = queriedAt - signal.current.timestamp;
    if (freshnessSeconds > FRESHNESS_LIMIT_SECONDS) {
      throw new GraphProbeError(
        'validation',
        `current observation is ${describeElapsed(freshnessSeconds)} old`,
        {
          freshnessSeconds,
        },
      );
    }
    return {
      target,
      signal,
      reportedNetwork: reading.reportedNetwork,
      freshnessSeconds,
      failure: null,
    };
  } catch (error) {
    const kind = isGraphProbeError(error) ? error.kind : 'unexpected';
    const message = error instanceof Error ? error.message : String(error);
    return {
      target,
      signal: null,
      reportedNetwork: null,
      freshnessSeconds: null,
      failure: { kind, message: client.redact(message) },
    };
  }
}

function formatOutcome(outcome: ProbeOutcome): string {
  const t = outcome.target;
  const head = `[${t.chain}] ${t.protocol} (${t.slug}) subgraph=${t.subgraphId}`;
  if (outcome.signal === null || outcome.failure !== null) {
    return `${head}\n  FAIL kind=${outcome.failure?.kind ?? 'unknown'}: ${outcome.failure?.message ?? 'no signal'}`;
  }
  const s = outcome.signal;
  const p = s.provenance;
  const blockTs =
    p.block.timestamp === null ? 'n/a' : new Date(p.block.timestamp * 1000).toISOString();
  return [
    head,
    `  deployment=${p.deploymentId ?? 'n/a'} block=${p.block.number} @ ${blockTs} hasIndexingErrors=${p.hasIndexingErrors} schema=${p.schemaVersion ?? 'n/a'} subgraph=${p.subgraphVersion ?? 'n/a'} methodology=${p.methodologyVersion ?? 'n/a'} network=${outcome.reportedNetwork ?? 'n/a'}`,
    `  window: baseline ${new Date(s.baseline.timestamp * 1000).toISOString()} (${s.baseline.source}) → current ${new Date(s.current.timestamp * 1000).toISOString()} (${s.current.source}); elapsed ${describeElapsed(s.elapsedSeconds)}, target 24h 00m, current is ${describeElapsed(outcome.freshnessSeconds ?? 0)} old at query time`,
    `  TVL current=${s.current.totalValueLockedUsd} baseline=${s.baseline.totalValueLockedUsd} delta=${s.deltaUsd} (${s.deltaPercent}%)`,
  ].join('\n');
}

export interface GateResult {
  readonly passed: boolean;
  readonly distinctProtocolsWithSignal: number;
  readonly deploymentsQueried: number;
}

export function evaluateGate(
  outcomes: readonly ProbeOutcome[],
  minimumProtocols: number,
): GateResult {
  const protocols = new Set(
    outcomes.filter((o) => o.signal !== null && o.failure === null).map((o) => o.target.protocol),
  );
  return {
    passed: protocols.size >= minimumProtocols,
    distinctProtocolsWithSignal: protocols.size,
    deploymentsQueried: outcomes.length,
  };
}

async function writeDetails(
  outcomes: readonly ProbeOutcome[],
  redact: (s: string) => string,
): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(here, '..', '..', '..', 'output', 'graph-probe');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `${stamp}.json`);
  const body = redact(JSON.stringify(outcomes, null, 2));
  await writeFile(file, body, { encoding: 'utf8', mode: 0o600 });
  return file;
}

export async function main(): Promise<number> {
  const apiKey = process.env['GRAPH_API_KEY'];
  const gatewayBaseUrl = process.env['GRAPH_GATEWAY_URL'];
  const redactEarly = createRedactor([apiKey]);
  let client: GraphGatewayClient;
  try {
    client = new GraphGatewayClient({ apiKey, gatewayBaseUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`probe:live cannot start: ${redactEarly(message)}`);
    return 2;
  }

  console.log(`CAS Chainwatch live Graph probe. query sha256=${queryDocumentSha256()}`);
  console.log(
    `Queried at ${new Date().toISOString()} through the configured gateway (credentials redacted).`,
  );

  const ethereum: ProbeOutcome[] = [];
  for (const target of ETHEREUM_LENDING_TARGETS) {
    const outcome = await probeTarget(client, target);
    ethereum.push(outcome);
    console.log(formatOutcome(outcome));
  }
  const ethereumGate = evaluateGate(ethereum, ETHEREUM_GATE_MINIMUM_PROTOCOLS);

  const base: ProbeOutcome[] = [];
  for (const target of BASE_LENDING_TARGETS) {
    const outcome = await probeTarget(client, target);
    base.push(outcome);
    console.log(formatOutcome(outcome));
  }
  const baseGate = evaluateGate(base, 1);

  const detailsFile = await writeDetails([...ethereum, ...base], client.redact);

  console.log('');
  console.log(
    `Ethereum gate: ${ethereumGate.passed ? 'PASS' : 'FAIL'} (${ethereumGate.distinctProtocolsWithSignal} distinct protocols with a valid signal across ${ethereumGate.deploymentsQueried} deployments; minimum ${ETHEREUM_GATE_MINIMUM_PROTOCOLS})`,
  );
  console.log(
    `Base secondary: ${baseGate.passed ? 'PASS' : 'FAIL'} (${baseGate.distinctProtocolsWithSignal} distinct protocols with a valid signal across ${baseGate.deploymentsQueried} deployments; reported, does not affect the exit code)`,
  );
  console.log(`Details written to ${detailsFile} (ignored by Git).`);
  return ethereumGate.passed ? 0 : 1;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const redact = createRedactor([process.env['GRAPH_API_KEY']]);
      console.error(
        `probe:live failed: ${redact(error instanceof Error ? error.message : String(error))}`,
      );
      process.exitCode = 1;
    },
  );
}
