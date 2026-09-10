import type { Redactor } from '@cas/database';

import { toSingleLine } from '../editorial/display.js';
import type { EvidenceReport } from './run.js';
import type { IngestSnapshotOutcome } from './signals.js';

/**
 * Count-only and identifier-only output for the evidence commands.
 *
 * The same boundary Sprints 2 to 4 use: every line is redacted for the
 * connection string and rendered as exactly one physical line, and the
 * vocabulary is fixed. No provider payload, no raw article text, no private
 * rationale and no URL reaches a printed line.
 */

function line(value: string, redact: Redactor): string {
  return toSingleLine(redact(value));
}

export function formatSnapshotIngest(outcome: IngestSnapshotOutcome, redact: Redactor): string[] {
  const run = outcome.run;
  return [
    `graph:signals: ${outcome.outcome === 'ingested' ? 'ingested' : 'already ingested'} run=${run.id} origin=${run.dataOrigin} status=${run.status}`,
    `versions: signal=${run.signalVersion} contract=${run.contractVersion} contractHash=${run.contractHash}`,
    `provenance: gatewayHost=${run.gatewayHost} querySha256=${run.querySha256}`,
    `counts: targets=${run.targetCount} signals=${run.signalCount} failed=${run.failedTargetCount}`,
  ].map((entry) => line(entry, redact));
}

export function formatEvidenceReport(report: EvidenceReport, redact: Redactor): string[] {
  const run = report.run;
  return [
    `evidence:report: run=${run.id} clusteringRun=${run.clusteringRunId} signalRun=${run.signalRunId} origin=${run.dataOrigin} status=${run.status}`,
    `versions: resolver=${run.resolverVersion} contract=${run.contractVersion} contractHash=${run.contractHash}`,
    `states: total=${report.states.total} reportedOnly=${report.states.reportedOnly} onchainObserved=${report.states.onchainObserved} corroborated=${report.states.corroborated} contradicted=${report.states.contradicted}`,
    `associations: suggested=${report.associations.suggested} accepted=${report.associations.accepted} rejected=${report.associations.rejected}`,
    `reconciled=${report.reconciled ? 'yes' : 'no'}`,
  ].map((entry) => line(entry, redact));
}

/** One sanitized evidence record, by identifier. Never a payload. */
export function formatSignalRecord(
  signal: {
    readonly id: string;
    readonly signalRunId: string;
    readonly dataOrigin: string;
    readonly chain: string;
    readonly protocolSlug: string;
    readonly subgraphDeploymentId: string | null;
    readonly blockNumber: number | null;
    readonly observedAt: string;
    readonly elapsedSeconds: number;
    readonly deltaPercent: string;
    readonly responseDigest: string;
  },
  redact: Redactor,
): string[] {
  return [
    `graph:signal: id=${signal.id} run=${signal.signalRunId} origin=${signal.dataOrigin}`,
    `target: chain=${signal.chain} protocol=${signal.protocolSlug} deployment=${signal.subgraphDeploymentId ?? '-'}`,
    `observation: at=${signal.observedAt} block=${signal.blockNumber ?? '-'} elapsedSeconds=${signal.elapsedSeconds} deltaPercent=${signal.deltaPercent}`,
    `digest: ${signal.responseDigest}`,
  ].map((entry) => line(entry, redact));
}
