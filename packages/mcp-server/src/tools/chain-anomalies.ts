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
import { quoteEvidence, type QuotedEvidence } from '../safety/text.js';
import { ANOMALY_BOUNDARY_SENTENCE, RESULT_NOTICE, TELEMETRY_SENTENCE } from '../schemas/common.js';
import type { ChainAnomaliesArguments } from '../schemas/input.js';
import type {
  AnomalyEntryDto,
  AnomalyEntryProvenanceDto,
  ChainAnomaliesOutput,
  LiveTargetDto,
} from '../schemas/output.js';
import type { IncidentReadStoreProvider, SignalRunBoundary } from '../store/read-store.js';
import { canonicalUuid, type ToolContext } from './shared.js';

/**
 * `chain_anomalies`, in two explicitly selected modes that share nothing.
 *
 * Stored mode evaluates one named completed signal run at one reproducible
 * historical boundary, and labels it with the same engine the worker uses.
 * The boundary (`SignalRunBoundary`) is the named run's own completion instant
 * and the caller's as-of instant: only completed runs of the same origin and
 * signal version that completed at or before the named run contribute, only
 * their observations at or before `asOf` contribute, the as-of cut precedes
 * the per-target limit, and ties are broken by run completion and signal
 * identifier. A run completed later, a run still running, or an observation
 * after `asOf` cannot change the result, so the same request against the same
 * stored history yields the same bytes. Each entry names the run and signal
 * that actually produced the observation it labels, and the result names the
 * boundary and the runs that contributed. All of it is read in one
 * transaction, from one snapshot, under the call's abort signal.
 *
 * Live mode queries the provider now through the Sprint 1 client for one
 * chain's configured targets, with the call's abort signal on every request
 * socket, so cancelling the call aborts the sockets. A live failure is a
 * failure in the result; nothing in live mode reads the store, and nothing in
 * stored mode reaches a provider.
 */

export interface ChainAnomaliesDependencies {
  readonly store: IncidentReadStoreProvider | null;
  readonly live: LiveSignalSource | null;
  readonly labeller: AnomalyLabeller;
  readonly now: () => Date;
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

const NO_PROVENANCE: AnomalyEntryProvenanceDto = {
  latestSignalRunId: null,
  latestSignalId: null,
  latestObservedAt: null,
  observationsUsed: 0,
  contributingRunCount: 0,
};

function toEntryDto(
  entry: ReturnType<AnomalyLabeller['label']>[number],
  provenance: AnomalyEntryProvenanceDto,
): AnomalyEntryDto {
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
    provenance,
    reasonCodes: [...entry.reasonCodes],
    evidenceLimitation: entry.evidenceLimitation,
  };
}

async function storedAnomalies(
  deps: ChainAnomaliesDependencies,
  signalRunId: string,
  asOf: Date,
  context: ToolContext,
): Promise<ChainAnomaliesOutput> {
  if (deps.store === null) throw new ToolError('database_not_configured');
  return deps.store.withReadTransaction(
    async (store) => {
      const run = await store.getSignalRun(signalRunId);
      if (run === null) throw new ToolError('signal_run_not_found');
      if (run.status !== 'completed' || run.completedAt === null) {
        throw new ToolError('signal_run_not_completed');
      }
      const boundary: SignalRunBoundary = {
        signalRunId: run.id,
        dataOrigin: run.dataOrigin,
        signalVersion: run.signalVersion,
        completedAt: run.completedAt,
        asOf: asOf.toISOString(),
      };
      const targets = await store.listSignalTargets(boundary, ANOMALY_TARGETS_LIMIT);
      const series: ChainSeries[] = [];
      const provenanceByTarget = new Map<string, AnomalyEntryProvenanceDto>();
      /** Completion instant of every run that contributed at least one used observation. */
      const contributingRuns = new Map<string, string>();
      let observationsRead = 0;
      for (const target of targets) {
        const history = await store.listSignalHistory(
          boundary,
          target.chain,
          target.protocolSlug,
          deps.labeller.maximumObservationsPerTarget,
        );
        observationsRead += history.length;
        const latest = history[history.length - 1];
        const runsOfTarget = new Set<string>();
        for (const row of history) {
          runsOfTarget.add(row.signalRunId);
          contributingRuns.set(row.signalRunId, row.runCompletedAt);
        }
        const targetId = `${target.chain}:${target.protocolSlug}`;
        provenanceByTarget.set(targetId, {
          latestSignalRunId: latest?.signalRunId ?? null,
          latestSignalId: latest?.signalId ?? null,
          latestObservedAt: latest?.observedAt ?? null,
          observationsUsed: history.length,
          contributingRunCount: runsOfTarget.size,
        });
        series.push({
          targetId,
          chain: target.chain,
          protocolSlug: target.protocolSlug,
          dataOrigin: target.dataOrigin,
          // The run that produced the observation being labelled; the named
          // run only when the boundary holds no observation of this target.
          provenanceId: latest?.signalRunId ?? run.id,
          observations: history.map((row) => ({
            observedAt: seconds(row.observedAt),
            deltaPercent: row.deltaPercent,
          })),
        });
      }
      const labelled = deps.labeller.label(series, Math.floor(asOf.getTime() / 1000));
      const entries = labelled
        .slice(0, deps.labeller.maximumEntries)
        .map((entry) =>
          toEntryDto(
            entry,
            provenanceByTarget.get(`${entry.chain}:${entry.protocolSlug}`) ?? NO_PROVENANCE,
          ),
        );
      const completions = [...contributingRuns.values()].sort();
      return {
        notice: RESULT_NOTICE,
        tool: 'chain_anomalies',
        mode: 'stored',
        asOf: boundary.asOf,
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
          boundary: {
            requestedSignalRunId: run.id,
            completedAt: run.completedAt,
            asOf: boundary.asOf,
            dataOrigin: run.dataOrigin,
            signalVersion: run.signalVersion,
            rule: ANOMALY_BOUNDARY_SENTENCE,
            contributingRunCount: contributingRuns.size,
            earliestContributingRunCompletedAt: completions[0] ?? null,
            latestContributingRunCompletedAt: completions[completions.length - 1] ?? null,
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
    },
    { signal: context.signal },
  );
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
  context: ToolContext,
): Promise<ChainAnomaliesOutput> {
  if (deps.live === null) throw new ToolError('graph_credential_missing');
  const observation = await deps.live.observe(chain, context.signal);
  throwIfAborted(context.signal);
  const configured =
    chain === 'ethereum' ? ETHEREUM_LENDING_TARGETS.length : BASE_LENDING_TARGETS.length;
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  const redactBoth = (value: string): string => context.redact(observation.redact(value));
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
  context: ToolContext,
): Promise<ChainAnomaliesOutput> {
  if (args.mode === 'live') {
    if (args.chain === undefined) throw new ToolError('invalid_arguments', { argument: 'chain' });
    return liveAnomalies(deps, args.chain, context);
  }
  if (args.signalRunId === undefined)
    throw new ToolError('invalid_arguments', { argument: 'signalRunId' });
  const asOf = args.asOf === undefined ? deps.now() : new Date(args.asOf);
  return storedAnomalies(deps, canonicalUuid(args.signalRunId), asOf, context);
}
