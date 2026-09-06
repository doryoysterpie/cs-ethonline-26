import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GraphGatewayClient, type FetchLike } from './client.js';
import {
  BASE_GATE_MINIMUM_PROTOCOLS,
  BASE_LENDING_TARGETS,
  ETHEREUM_GATE_MINIMUM_PROTOCOLS,
  ETHEREUM_LENDING_TARGETS,
} from './deployments.js';
import {
  assertUniqueTargets,
  evaluateChainGate,
  evaluateFailedTarget,
  evaluateTarget,
  type ChainGateResult,
  type DeploymentTarget,
  type TargetEvaluation,
} from './gate.js';
import { queryDocumentSha256 } from './query.js';
import { createRedactor } from './redact.js';
import { describeElapsed } from './tvl-delta.js';

/**
 * Sprint 1 live probe. Runs the common standardized query against every
 * selected deployment, validates each response against the registry's
 * declared expectations, computes the TVL-delta signal, prints a concise
 * redacted summary, and writes details under the ignored `output/` path.
 *
 * Exit codes: 0 Ethereum gate passed; 1 Ethereum gate failed; 2 credential
 * missing or configuration invalid. Base is reported truthfully as PASS/KEEP
 * or FAIL/DROP and never changes the exit code. There is no fixture or replay
 * path in this program.
 */

export interface ProbeOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: FetchLike | undefined;
  readonly now?: (() => Date) | undefined;
  readonly ethereumTargets?: readonly DeploymentTarget[] | undefined;
  readonly baseTargets?: readonly DeploymentTarget[] | undefined;
  /** Write the redacted details file under output/graph-probe. Default true. */
  readonly writeDetails?: boolean | undefined;
  readonly log?: ((line: string) => void) | undefined;
  readonly error?: ((line: string) => void) | undefined;
}

export interface ProbeRun {
  readonly code: 0 | 1 | 2;
  readonly ethereum: ChainGateResult | null;
  readonly base: ChainGateResult | null;
  readonly evaluations: readonly TargetEvaluation[];
  readonly detailsFile: string | null;
}

async function probeTarget(
  client: GraphGatewayClient,
  target: DeploymentTarget,
): Promise<TargetEvaluation> {
  let reading;
  try {
    reading = await client.queryStandardizedTvl({
      subgraphId: target.subgraphId,
      targetChain: target.chain,
      targetSlug: target.slug,
    });
  } catch (error) {
    return evaluateFailedTarget(target, error, client.redact);
  }
  const queriedAtSeconds = Math.floor(Date.parse(reading.provenance.queriedAtUtc) / 1000);
  return evaluateTarget(target, reading, queriedAtSeconds, client.redact);
}

function iso(seconds: number | null): string {
  return seconds === null ? 'n/a' : new Date(seconds * 1000).toISOString();
}

export function formatEvaluation(e: TargetEvaluation): string {
  const t = e.target;
  const head = `[${t.chain}] ${t.label} subgraph=${t.subgraphId}`;
  if (!e.valid || e.signal === null || e.reading === null) {
    const f = e.failure;
    const lines = [`${head}\n  FAIL kind=${f?.kind ?? 'unknown'}: ${f?.message ?? 'no signal'}`];
    for (const m of e.mismatches) {
      lines.push(`  mismatch field=${m.field} expected=${m.expected} received=${m.received}`);
    }
    return lines.join('\n');
  }
  const s = e.signal;
  const p = s.provenance;
  const id = e.reading.identity;
  return [
    head,
    `  provider identity: name=${JSON.stringify(id.name)} slug=${id.slug} network=${id.network} (${id.chain}) type=${id.protocolType} schema=${id.schemaVersion}; configured slug=${t.slug}`,
    `  deployment=${p.deploymentId ?? 'n/a'} block=${p.block.number} @ ${iso(p.block.timestamp)} hasIndexingErrors=${p.hasIndexingErrors} subgraphVersion=${p.subgraphVersion ?? 'n/a'} methodology=${p.methodologyVersion ?? 'n/a'} endpoint=${p.provider} ${p.providerBase}`,
    `  window: baseline ${iso(s.baseline.timestamp)} (${s.baseline.source}) → current ${iso(s.current.timestamp)} (${s.current.source}); elapsed ${describeElapsed(s.elapsedSeconds)}, target 24h 00m; freshness ${e.freshness?.reason ?? 'n/a'} (age ${e.freshness?.ageSeconds ?? 'n/a'} s)`,
    `  TVL current=${s.current.totalValueLockedUsd} baseline=${s.baseline.totalValueLockedUsd} delta=${s.deltaUsd} (${s.deltaPercent}%)`,
  ].join('\n');
}

export function formatGate(
  name: string,
  g: ChainGateResult,
  passLabel: string,
  failLabel: string,
): string {
  const verdict = g.passed ? passLabel : failLabel;
  const summary = `${g.valid} valid of ${g.configured} configured; ${g.distinctIdentities} distinct provider identities, ${g.distinctSubgraphIds} distinct subgraph IDs, ${g.distinctDeploymentIds} distinct deployment IDs; minimum ${g.minimum}${g.requireAll ? ', all configured targets required' : ''}`;
  const reasons = g.reasons.length > 0 ? `\n  reasons: ${g.reasons.join(' | ')}` : '';
  return `${name}: ${verdict} (${summary})${reasons}`;
}

async function writeDetails(
  evaluations: readonly TargetEvaluation[],
  redact: (s: string) => string,
): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(here, '..', '..', '..', 'output', 'graph-probe');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `${stamp}.json`);
  const body = redact(JSON.stringify(evaluations, null, 2));
  await writeFile(file, body, { encoding: 'utf8', mode: 0o600 });
  return file;
}

export async function runProbe(options: ProbeOptions): Promise<ProbeRun> {
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const apiKey = options.env['GRAPH_API_KEY'];
  const gatewayBaseUrl = options.env['GRAPH_GATEWAY_URL'];
  const redactEarly = createRedactor([apiKey]);
  const ethereumTargets = options.ethereumTargets ?? ETHEREUM_LENDING_TARGETS;
  const baseTargets = options.baseTargets ?? BASE_LENDING_TARGETS;

  let client: GraphGatewayClient;
  try {
    assertUniqueTargets([...ethereumTargets, ...baseTargets]);
    client = new GraphGatewayClient({
      apiKey,
      gatewayBaseUrl,
      fetchImpl: options.fetchImpl,
      now: options.now,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(`graph:probe cannot start: ${redactEarly(message)}`);
    return { code: 2, ethereum: null, base: null, evaluations: [], detailsFile: null };
  }

  log(`CAS Chainwatch live Graph probe. query sha256=${queryDocumentSha256()}`);
  log(
    `Queried at ${(options.now ?? (() => new Date()))().toISOString()} via ${client.gateway.provider} ${client.gateway.base} (credentials redacted).`,
  );

  const evaluations: TargetEvaluation[] = [];
  for (const target of ethereumTargets) {
    const e = await probeTarget(client, target);
    evaluations.push(e);
    log(formatEvaluation(e));
  }
  const ethereum = evaluateChainGate(evaluations.slice(0, ethereumTargets.length), {
    chain: 'ethereum',
    minimum: ETHEREUM_GATE_MINIMUM_PROTOCOLS,
    requireAll: false,
  });

  for (const target of baseTargets) {
    const e = await probeTarget(client, target);
    evaluations.push(e);
    log(formatEvaluation(e));
  }
  const base = evaluateChainGate(evaluations.slice(ethereumTargets.length), {
    chain: 'base',
    minimum: BASE_GATE_MINIMUM_PROTOCOLS,
    requireAll: true,
  });

  const detailsFile =
    options.writeDetails === false ? null : await writeDetails(evaluations, client.redact);

  log('');
  log(formatGate('Ethereum gate', ethereum, 'PASS', 'FAIL'));
  log(
    formatGate('Base secondary', base, 'PASS/KEEP', 'FAIL/DROP') +
      ' [does not affect the exit code]',
  );
  if (detailsFile !== null) log(`Details written to ${detailsFile} (ignored by Git).`);
  return { code: ethereum.passed ? 0 : 1, ethereum, base, evaluations, detailsFile };
}

export async function main(): Promise<number> {
  const run = await runProbe({ env: process.env, writeDetails: true });
  return run.code;
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
        `graph:probe failed: ${redact(error instanceof Error ? error.message : String(error))}`,
      );
      process.exitCode = 1;
    },
  );
}
