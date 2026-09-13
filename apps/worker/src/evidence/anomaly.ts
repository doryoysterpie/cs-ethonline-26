import {
  countReportingWindow,
  getClusteringRun,
  getGraphSignalRun,
  listSignalHistory,
  listSignalTargets,
  type Database,
  type Redactor,
} from '@cas/database';
import {
  anomalyFeed,
  EVIDENCE_CONTRACT,
  type AnomalyFeed,
  type ChainTargetSeries,
  type ReportingWindow,
} from '@cas/evidence';

import { toSingleLine } from '../editorial/display.js';
import { IngestionError } from '../editorial/errors.js';

/**
 * Building the anomaly feed from stored signals and explicitly bounded
 * reporting windows.
 *
 * Both halves are required by the September 10 gate and both are here: chain
 * movements against a rolling baseline, and reporting movements against prior
 * windows. Neither window is inferred. A reporting window is two instants the
 * caller supplied, because decision D10 has not fixed an editorial week, and
 * no weekly candidate decision is read as a feature or a label.
 *
 * Every emitted line carries the origin of the data behind it, so a fixture
 * demonstration and a live observation are never confused in the output.
 */

export interface AnomalyRequest {
  readonly signalRunId: string;
  /** Optional reporting side. Both bounds are required together. */
  readonly clusteringRunId?: string | undefined;
  readonly windows?: readonly { readonly startsAt: string; readonly endsAt: string }[] | undefined;
  readonly now?: (() => Date) | undefined;
}

function configuration(code: string, message: string): IngestionError {
  return new IngestionError('configuration', code, message);
}

/** Assembles the feed. Reads stored rows only; never calls a provider. */
export async function buildAnomalyFeed(
  db: Database,
  request: AnomalyRequest,
): Promise<AnomalyFeed> {
  const now = request.now ?? (() => new Date());
  const signalRun = await db.withClient((client) => getGraphSignalRun(client, request.signalRunId));
  if (signalRun === null || signalRun.status !== 'completed') {
    throw configuration('signal_run_not_completed', 'no completed signal run with that id');
  }

  const targets = await db.withClient((client) => listSignalTargets(client, signalRun.id));
  const series: ChainTargetSeries[] = [];
  for (const target of targets) {
    const history = await db.withClient((client) =>
      listSignalHistory(
        client,
        target.chain,
        target.protocolSlug,
        target.dataOrigin,
        EVIDENCE_CONTRACT.anomaly.maximumObservationsPerTarget,
      ),
    );
    series.push({
      targetId: `${target.chain}:${target.protocolSlug}`,
      chain: target.chain,
      protocolSlug: target.protocolSlug,
      dataOrigin: target.dataOrigin,
      provenanceId: signalRun.id,
      observations: history.map((row) => ({
        observedAt: Math.floor(Date.parse(row.observedAt) / 1000),
        deltaPercent: row.deltaPercent,
      })),
    });
  }

  const windows: ReportingWindow[] = [];
  if (request.clusteringRunId !== undefined) {
    if (request.windows === undefined || request.windows.length === 0) {
      throw configuration(
        'windows_required',
        'a reporting side needs explicit window bounds; no editorial week is inferred',
      );
    }
    const clustering = await db.withClient((client) =>
      getClusteringRun(client, request.clusteringRunId ?? ''),
    );
    if (clustering === null || clustering.status !== 'completed') {
      throw configuration(
        'clustering_run_not_completed',
        'no completed clustering run with that id',
      );
    }
    for (const [index, bounds] of request.windows.entries()) {
      const counts = await db.withClient((client) =>
        countReportingWindow(client, clustering.id, bounds.startsAt, bounds.endsAt),
      );
      windows.push({
        windowId: `${clustering.id}:${index}`,
        startsAt: Math.floor(Date.parse(bounds.startsAt) / 1000),
        endsAt: Math.floor(Date.parse(bounds.endsAt) / 1000),
        dataOrigin: clustering.dataOrigin,
        provenanceId: clustering.id,
        sourceStoryCount: counts.sourceStoryCount,
        incidentCount: counts.incidentCount,
        multiSourceIncidentCount: counts.multiSourceIncidentCount,
      });
    }
  }

  return anomalyFeed(series, windows, Math.floor(now().getTime() / 1000));
}

/**
 * The feed as printed lines. Identifier, label, counts and fixed vocabulary
 * only, with the origin and the limitation on every entry.
 */
export function formatAnomalyFeed(feed: AnomalyFeed, redact: Redactor): string[] {
  const lines = [
    `evidence:anomaly: entries=${feed.entries.length} chainTargets=${feed.stats.chainTargets} reportingWindows=${feed.stats.reportingWindows}`,
    `labels: spikes=${feed.stats.spikes} insufficientHistory=${feed.stats.insufficientHistory} stale=${feed.stats.stale} missing=${feed.stats.missing} bounded=${feed.stats.boundsReached}`,
  ];
  for (const entry of feed.entries) {
    lines.push(
      `entry: type=${entry.signalType} label=${entry.label} subject=${entry.subjectId}` +
        ` chain=${entry.chain ?? '-'} protocol=${entry.protocolSlug ?? '-'}` +
        ` observed=${entry.observationWindow.startsAt}..${entry.observationWindow.endsAt}` +
        ` baseline=${entry.baselineWindow === null ? '-' : `${entry.baselineWindow.startsAt}..${entry.baselineWindow.endsAt}`}` +
        ` value=${entry.value} threshold=${entry.threshold} origin=${entry.dataOrigin}` +
        ` provenance=${entry.provenanceId} codes=${entry.reasonCodes.join(',') || '-'}`,
    );
    lines.push(`limitation: ${entry.evidenceLimitation}`);
  }
  return lines.map((entry) => toSingleLine(redact(entry)));
}
