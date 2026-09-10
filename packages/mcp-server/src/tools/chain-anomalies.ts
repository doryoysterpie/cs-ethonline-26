import type { ChainId } from '@cas/contracts';
import {
  BASE_LENDING_TARGETS,
  ETHEREUM_LENDING_TARGETS,
  type TargetEvaluation,
} from '@cas/graph-evidence';

import { ANOMALY_TARGETS_LIMIT, IDENTITY_MAX_CHARACTERS } from '../bounds.js';
import type { AnomalyLabeller, ChainSeries } from '../engines/anomaly.js';
import type { LiveSignalSource } from '../engines/live-graph.js';
import { throwIfAborted } from '../safety/cancellation.js';
import { ToolError } from '../safety/errors.js';
import type { Redactor } from '../safety/redact.js';
import { quoteEvidence, type QuotedEvidence } from '../safety/text.js';
import { RESULT_NOTICE, TELEMETRY_SENTENCE } from '../schemas/common.js';
import type { ChainAnomaliesArguments } from '../schemas/input.js';
import type { AnomalyEntryDto, ChainAnomaliesOutput, LiveTargetDto } from '../schemas/output.js';
import type { IncidentReadStore } from '../store/read-store.js';
import { canonicalUuid } from './shared.js';

/**
 * `chain_anomalies`, in two explicitly selected modes that share nothing.
 *
 * Stored mode reads one named completed signal run and the stored history of
 * that run's origin, and labels it with the same engine the worker uses. Live
 * mode queries the provider now through the Sprint 1 client for one chain's
 * configured targets. A live failure is a failure in the result; nothing in
 * live mode reads the store, and nothing in stored mode reaches a provider.
 */

export interface ChainAnomaliesDependencies {
  readonly store: IncidentReadStore | null;
  readonly live: LiveSignalSource | null;
  readonly labeller: AnomalyLabeller;
  readonly now: () => Date;
  /** The call's abort signal: every store read and every live request observes it. */
  readonly signal: AbortSignal;
  /** The runtime redactor, applied to every quoted value before escaping. */
  readonly redact: Redactor;
}

/** Fixed sentence per live failure kind. The provider's own text never leaves. */
const FAILURE_SENTENCES = {
  credential: 'the credential was refused or missing',
  http: 'the provider answered with an error status',
  graphql: 'the provider answered with GraphQL errors',
  schema: 'the provider response did not match the standardized schema',
  validation: 'the live identity, freshness or configuration check failed',
  indexing: 'the provider reports indexing errors for this deployment',
  timeout: 'the provider did not answer within the request timeout',
  network: 'the provider could not be reached',
  unexpected: 'the target failed for an unclassified reason',
} as const;
type FailureKind = keyof typeof FAILURE_SENTENCES;

const LIVE_BASELINE_NOTE =
  'A live observation is one fresh reading. The anomaly label needs a stored baseline of prior observations, so a live entry is labelled from the observation alone and is normally insufficient_history; the telemetry value is the movement itself.';

function failureKind(kind: string): FailureKind {
  return kind in FAILURE_SENTENCES ? (kind as FailureKind) : 'unexpected';
}

function seconds(instant: string): number {
  return Math.floor(Date.parse(instant) / 1000);
}

function toEntryDto(entry: ReturnType<AnomalyLabeller['label']>[number]): AnomalyEntryDto {
  return {
    label: entry.label,
    chain: entry.chain,
    protocolSlug: entry.protocolSlug,
    observationWindow: entry.observationWindow,
    baselineWindow: entry.baselineWindow,
    value: entry.value,
    threshold: entry.threshold,
    dataOrigin: entry.dataOrigin,
    provenanceId: entry.provenanceId,
    reasonCodes: [...entry.reasonCodes],
    evidenceLimitation: entry.evidenceLimitation,
  };
}

async function storedAnomalies(
  deps: ChainAnomaliesDependencies,
  signalRunId: string,
  asOf: Date,
): Promise<ChainAnomaliesOutput> {
  if (deps.store === null) throw new ToolError('database_not_configured');
  const run = await deps.store.getSignalRun(signalRunId, deps.signal);
  if (run === null) throw new ToolError('signal_run_not_found');
  if (run.status !== 'completed' || run.completedAt === null) {
    throw new ToolError('signal_run_not_completed');
  }
  throwIfAborted(deps.signal);
  const targets = await deps.store.listSignalTargets(run.id, ANOMALY_TARGETS_LIMIT, deps.signal);
  const series: ChainSeries[] = [];
  let observationsRead = 0;
  for (const target of targets) {
    throwIfAborted(deps.signal);
    // The history query is scoped by the run's origin inside the store, so a
    // replayed series and a live series of the same target never mix.
    const history = await deps.store.listSignalHistory(
      target.chain,
      target.protocolSlug,
      target.dataOrigin,
      deps.labeller.maximumObservationsPerTarget,
      deps.signal,
    );
    observationsRead += history.length;
    series.push({
      targetId: `${target.chain}:${target.protocolSlug}`,
      chain: target.chain,
      protocolSlug: target.protocolSlug,
      dataOrigin: target.dataOrigin,
      provenanceId: run.id,
      observations: history.map((row) => ({
        observedAt: seconds(row.observedAt),
        deltaPercent: row.deltaPercent,
      })),
    });
  }
  const labelled = deps.labeller.label(series, Math.floor(asOf.getTime() / 1000));
  const entries = labelled.slice(0, deps.labeller.maximumEntries).map(toEntryDto);
  return {
    notice: RESULT_NOTICE,
    tool: 'chain_anomalies',
    mode: 'stored',
    asOf: asOf.toISOString(),
    telemetrySentence: TELEMETRY_SENTENCE,
    stored: {
      signalRun: {
        signalRunId: run.id,
        dataOrigin: run.dataOrigin,
        status: 'completed',
        signalVersion: run.signalVersion,
        contractVersion: run.contractVersion,
        contractHash: run.contractHash,
        querySha256: run.querySha256,
        gatewayHost: run.gatewayHost,
        targetCount: run.targetCount,
        signalCount: run.signalCount,
        completedAt: run.completedAt,
      },
      targetsEvaluated: series.length,
      observationsRead,
      entries,
      stats: {
        spikes: entries.filter((entry) => entry.label.endsWith('_spike')).length,
        insufficientHistory: entries.filter((entry) => entry.label === 'insufficient_history')
          .length,
        stale: entries.filter((entry) => entry.label === 'stale_observation').length,
        missing: entries.filter((entry) => entry.label === 'missing_observation').length,
        boundsReached: labelled.length - entries.length,
      },
    },
    live: null,
  };
}

function liveTargetDto(
  evaluation: TargetEvaluation,
  labeller: AnomalyLabeller,
  nowSeconds: number,
  redact: (value: string) => string,
): LiveTargetDto {
  // Provider-controlled values pass through the Sprint 1 client's own
  // redactor and the runtime's credential-variant redactor before they are
  // escaped or bounded, so an encoded key in a provider field is matched
  // whole (Track D finding F3).
  const quoted = (value: string | null | undefined): QuotedEvidence | null =>
    quoteEvidence(value, IDENTITY_MAX_CHARACTERS, redact);
  const requireQuoted = (value: string): QuotedEvidence =>
    quoted(value) ?? { text: '', truncated: false, trust: 'untrusted_quoted_evidence' };
  const target = {
    label: evaluation.target.label,
    chain: evaluation.target.chain,
    configuredSlug: evaluation.target.slug,
    subgraphId: evaluation.target.subgraphId,
  };
  if (!evaluation.valid || evaluation.signal === null || evaluation.reading === null) {
    const kind = failureKind(evaluation.failure?.kind ?? 'unexpected');
    return {
      target,
      outcome: 'failed',
      identity: null,
      signal: null,
      freshness: null,
      provenance: null,
      anomaly: null,
      failure: { kind, message: FAILURE_SENTENCES[kind] },
    };
  }
  const signal = evaluation.signal;
  const p = signal.provenance;
  const identity = evaluation.reading.identity;
  const [entry] = labeller.label(
    [
      {
        targetId: `${identity.chain}:${identity.slug}`,
        chain: identity.chain,
        protocolSlug: identity.slug,
        dataOrigin: 'live',
        provenanceId: p.subgraphId,
        observations: [{ observedAt: signal.current.timestamp, deltaPercent: signal.deltaPercent }],
      },
    ],
    nowSeconds,
  );
  return {
    target,
    outcome: 'valid',
    identity: {
      name: requireQuoted(identity.name),
      slug: requireQuoted(identity.slug),
      network: requireQuoted(identity.network),
      chain: identity.chain,
      protocolType: requireQuoted(identity.protocolType),
      schemaVersion: requireQuoted(identity.schemaVersion),
    },
    signal: {
      currentTimestamp: signal.current.timestamp,
      currentTvlUsd: signal.current.totalValueLockedUsd,
      baselineTimestamp: signal.baseline.timestamp,
      baselineTvlUsd: signal.baseline.totalValueLockedUsd,
      elapsedSeconds: signal.elapsedSeconds,
      deltaUsd: signal.deltaUsd,
      deltaPercent: signal.deltaPercent,
    },
    freshness:
      evaluation.freshness === null
        ? null
        : {
            fresh: evaluation.freshness.fresh,
            ageSeconds: evaluation.freshness.ageSeconds,
            limitSeconds: evaluation.freshness.limitSeconds,
            reason: evaluation.freshness.reason,
          },
    provenance: {
      origin: 'live',
      provider: p.provider,
      providerBase: p.providerBase,
      subgraphId: p.subgraphId,
      deploymentId: quoted(p.deploymentId),
      targetChain: p.targetChain,
      targetSlug: p.targetSlug,
      queriedAtUtc: p.queriedAtUtc,
      queryDocumentSha256: p.queryDocumentSha256,
      block: { number: p.block.number, hash: quoted(p.block.hash), timestamp: p.block.timestamp },
      snapshotTimestamps: [...p.snapshotTimestamps].slice(0, 64),
      hasIndexingErrors: p.hasIndexingErrors,
      schemaVersion: requireQuoted(p.schemaVersion),
      subgraphVersion: quoted(p.subgraphVersion),
      methodologyVersion: quoted(p.methodologyVersion),
    },
    anomaly:
      entry === undefined
        ? null
        : {
            label: entry.label,
            reasonCodes: [...entry.reasonCodes],
            value: entry.value,
            threshold: entry.threshold,
            evidenceLimitation: entry.evidenceLimitation,
          },
    failure: null,
  };
}

async function liveAnomalies(
  deps: ChainAnomaliesDependencies,
  chain: ChainId,
): Promise<ChainAnomaliesOutput> {
  if (deps.live === null) throw new ToolError('graph_credential_missing');
  const observation = await deps.live.observe(chain, deps.signal);
  throwIfAborted(deps.signal);
  const configured =
    chain === 'ethereum' ? ETHEREUM_LENDING_TARGETS.length : BASE_LENDING_TARGETS.length;
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  const redactBoth = (value: string): string => deps.redact(observation.redact(value));
  const targets = observation.evaluations.map((evaluation) =>
    liveTargetDto(evaluation, deps.labeller, nowSeconds, redactBoth),
  );
  return {
    notice: RESULT_NOTICE,
    tool: 'chain_anomalies',
    mode: 'live',
    asOf: observation.queriedAtUtc,
    telemetrySentence: TELEMETRY_SENTENCE,
    stored: null,
    live: {
      chain,
      provider: observation.provider,
      providerBase: observation.providerBase,
      queriedAtUtc: observation.queriedAtUtc,
      targetsConfigured: configured,
      targetsValid: targets.filter((target) => target.outcome === 'valid').length,
      targets,
      baselineNote: LIVE_BASELINE_NOTE,
    },
  };
}

export async function chainAnomalies(
  deps: ChainAnomaliesDependencies,
  args: ChainAnomaliesArguments,
): Promise<ChainAnomaliesOutput> {
  if (args.mode === 'live') {
    if (args.chain === undefined) throw new ToolError('invalid_arguments', { argument: 'chain' });
    return liveAnomalies(deps, args.chain);
  }
  if (args.signalRunId === undefined)
    throw new ToolError('invalid_arguments', { argument: 'signalRunId' });
  const asOf = args.asOf === undefined ? deps.now() : new Date(args.asOf);
  return storedAnomalies(deps, canonicalUuid(args.signalRunId), asOf);
}
