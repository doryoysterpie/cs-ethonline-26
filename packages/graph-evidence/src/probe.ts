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
import { safeDisplay } from './display.js';
import {
  evaluateChainGate,
  evaluateFailedTarget,
  evaluateTarget,
  validateRegistry,
  type ChainGateResult,
  type DeploymentTarget,
  type TargetEvaluation,
} from './gate.js';
import { queryDocumentSha256 } from './query.js';
import { createRedactor, type Redactor } from './redact.js';
import { describeElapsed } from './tvl-delta.js';

/**
 * Sprint 1 live probe. Runs the common standardized query against every
 * selected deployment, validates each response against the registry's
 * declared expectations, computes the TVL-delta signal, prints a concise
 * redacted summary, and writes details under the ignored `output/` path.
 *
 * Every emission boundary redacts credentials and renders provider-controlled
 * values as safe single-line text, so provider content can neither leak the
 * key nor forge a target or gate line.
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

/**
 * Format one evaluation for display. Every provider-controlled value is
 * redacted and rendered single-line before composition, and the composed
 * text is redacted again on the way out.
 */
export function formatEvaluation(e: TargetEvaluation, redact: Redactor): string {
  const d = (value: unknown): string => safeDisplay(redact(String(value)));
  const t = e.target;
  const head = `[${t.chain}] ${d(t.label)} subgraph=${d(t.subgraphId)}`;
  if (!e.valid || e.signal === null || e.reading === null) {
    const f = e.failure;
    const lines = [head, `  FAIL kind=${d(f?.kind ?? 'unknown')}: ${d(f?.message ?? 'no signal')}`];
    for (const m of e.mismatches) {
      lines.push(
        `  mismatch field=${d(m.field)} expected=${d(m.expected)} received=${d(m.received)}`,
      );
    }
    return redact(lines.join('\n'));
  }
  const s = e.signal;
  const p = s.provenance;
  const id = e.reading.identity;
  const lines = [
    head,
    `  provider identity: name=${JSON.stringify(d(id.name))} slug=${d(id.slug)} network=${d(id.network)} (${id.chain}) type=${d(id.protocolType)} schema=${d(id.schemaVersion)}; configured slug=${d(t.slug)}`,
    `  deployment=${d(p.deploymentId ?? 'n/a')} block=${p.block.number} @ ${iso(p.block.timestamp)} hasIndexingErrors=${p.hasIndexingErrors} subgraphVersion=${d(p.subgraphVersion ?? 'n/a')} methodology=${d(p.methodologyVersion ?? 'n/a')} endpoint=${p.provider} ${d(p.providerBase)}`,
    `  window: baseline ${iso(s.baseline.timestamp)} (${s.baseline.source}) → current ${iso(s.current.timestamp)} (${s.current.source}); elapsed ${describeElapsed(s.elapsedSeconds)}, target 24h 00m; freshness ${e.freshness?.reason ?? 'n/a'} (age ${e.freshness?.ageSeconds ?? 'n/a'} s)`,
    `  TVL current=${d(s.current.totalValueLockedUsd)} baseline=${d(s.baseline.totalValueLockedUsd)} delta=${d(s.deltaUsd)} (${d(s.deltaPercent)}%)`,
  ];
  return redact(lines.join('\n'));
}

/** Format a gate result. Reasons may carry provider values; they are redacted and single-line. */
export function formatGate(
  name: string,
  g: ChainGateResult,
  passLabel: string,
  failLabel: string,
  redact: Redactor,
): string {
  const verdict = g.passed ? passLabel : failLabel;
  const summary = `${g.valid} valid of ${g.configured} configured; ${g.distinctIdentities} distinct provider identities, ${g.distinctSubgraphIds} distinct subgraph IDs, ${g.distinctDeploymentIds} distinct deployment IDs; minimum ${g.minimum}${g.requireAll ? ', all configured targets required' : ''}`;
  const reasons =
    g.reasons.length > 0
      ? `\n  reasons: ${g.reasons.map((r) => safeDisplay(redact(r))).join(' | ')}`
      : '';
  return redact(`${name}: ${verdict} (${summary})${reasons}`);
}

/** Redacted JSON for the ignored details file. JSON escaping keeps every value single-line. */
export function serializeDetails(
  evaluations: readonly TargetEvaluation[],
  redact: Redactor,
): string {
  return redact(JSON.stringify(evaluations, null, 2));
}

async function writeDetails(
  evaluations: readonly TargetEvaluation[],
  redact: Redactor,
): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(here, '..', '..', '..', 'output', 'graph-probe');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `${stamp}.json`);
  await writeFile(file, serializeDetails(evaluations, redact), { encoding: 'utf8', mode: 0o600 });
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
    validateRegistry([...ethereumTargets, ...baseTargets]);
    client = new GraphGatewayClient({
      apiKey,
      gatewayBaseUrl,
      fetchImpl: options.fetchImpl,
      now: options.now,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(`graph:probe cannot start: ${safeDisplay(redactEarly(message))}`);
    return { code: 2, ethereum: null, base: null, evaluations: [], detailsFile: null };
  }
  const redact = client.redact;

  log(`CAS Chainwatch live Graph probe. query sha256=${queryDocumentSha256()}`);
  log(
    redact(
      `Queried at ${(options.now ?? (() => new Date()))().toISOString()} via ${client.gateway.provider} ${client.gateway.base} (credentials redacted).`,
    ),
  );

  const evaluations: TargetEvaluation[] = [];
  for (const target of ethereumTargets) {
    const e = await probeTarget(client, target);
    evaluations.push(e);
    log(formatEvaluation(e, redact));
  }
  const ethereum = evaluateChainGate(evaluations.slice(0, ethereumTargets.length), {
    chain: 'ethereum',
    minimum: ETHEREUM_GATE_MINIMUM_PROTOCOLS,
    requireAll: false,
  });

  for (const target of baseTargets) {
    const e = await probeTarget(client, target);
    evaluations.push(e);
    log(formatEvaluation(e, redact));
  }
  const base = evaluateChainGate(evaluations.slice(ethereumTargets.length), {
    chain: 'base',
    minimum: BASE_GATE_MINIMUM_PROTOCOLS,
    requireAll: true,
  });

  const detailsFile =
    options.writeDetails === false ? null : await writeDetails(evaluations, redact);

  log('');
  log(formatGate('Ethereum gate', ethereum, 'PASS', 'FAIL', redact));
  log(
    formatGate('Base secondary', base, 'PASS/KEEP', 'FAIL/DROP', redact) +
      ' [does not affect the exit code]',
  );
  if (detailsFile !== null) log(redact(`Details written to ${detailsFile} (ignored by Git).`));
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
        `graph:probe failed: ${safeDisplay(redact(error instanceof Error ? error.message : String(error)))}`,
      );
      process.exitCode = 1;
    },
  );
}
