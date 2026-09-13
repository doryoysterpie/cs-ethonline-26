import type { Redactor } from '@cas/database';

import { safeDisplay, toSingleLine } from '../editorial/display.js';
import type { ClusterRunOutcome } from './run.js';
import type { ClusteringReport } from './report.js';
import type { EffectiveView, ReviewActionOutcome, ReviewCounts } from './review.js';

/**
 * Clustering output: counts, identifiers, versions, hashes, statuses and fixed
 * vocabulary only. No title, URL, summary, description, raw field, path or
 * credential can appear here, because none of them is read. Every line passes
 * through the redactor and the single-line guard, exactly as the Sprint 2 and
 * Sprint 3 commands do.
 */

function line(value: string, redact: Redactor): string {
  return toSingleLine(redact(value));
}

export function formatClusteringRun(outcome: ClusterRunOutcome, redact: Redactor): string[] {
  const run = outcome.run;
  const head =
    outcome.outcome === 'clustered'
      ? `clustering:run: clustered run=${run.id}`
      : `clustering:run: already clustered as run=${run.id}; nothing written`;
  return [
    `${head} classificationRun=${run.classificationRunId} batch=${run.batchId} origin=${run.dataOrigin} status=${run.status}`,
    `versions: engine=${run.engineVersion} contract=${run.contractVersion} contractHash=${run.contractHash}`,
    `inputs: eligible=${run.eligibleRowCount} ineligible=${run.ineligibleRowCount}`,
    `groups: duplicates=${run.duplicateGroupCount} syndication=${run.syndicationGroupCount} incidents=${run.incidentCount}`,
    `incidents: singleton=${run.singletonIncidentCount} multiSource=${run.multiSourceIncidentCount} largest=${run.largestClusterSize} ambiguousLinks=${run.ambiguousLinkCount}`,
    `timing: started=${run.startedAt} completed=${run.completedAt ?? '-'} durationMs=${outcome.durationMs}`,
  ].map((entry) => line(entry, redact));
}

export function formatClusteringReport(report: ClusteringReport, redact: Redactor): string[] {
  const run = report.run;
  const kinds =
    report.kinds.length === 0
      ? 'none'
      : report.kinds.map((entry) => `${entry.kind}=${entry.count}`).join(' ');
  return [
    `clustering:report: run=${run.id} classificationRun=${run.classificationRunId} batch=${run.batchId} status=${run.status}`,
    `versions: engine=${run.engineVersion} contract=${run.contractVersion} contractHash=${run.contractHash}`,
    `inputs: eligible=${run.eligibleRowCount} ineligible=${run.ineligibleRowCount}`,
    `incidents: total=${run.incidentCount} singleton=${run.singletonIncidentCount} multiSource=${run.multiSourceIncidentCount} largest=${run.largestClusterSize}`,
    `kinds: ${kinds}`,
    `links: ambiguous=${run.ambiguousLinkCount}; reconciled=${report.reconciled ? 'yes' : 'NO'}`,
  ].map((entry) => line(entry, redact));
}

export function formatReviewCounts(counts: ReviewCounts, redact: Redactor): string[] {
  return [
    `clustering_review run=${counts.run.id} revision=${counts.revision} actions=${counts.actions} effectiveIncidents=${counts.effectiveIncidents} ambiguousLinks=${counts.ambiguousLinks} reviewMemberships=${counts.reviewMemberships}`,
  ].map((entry) => line(entry, redact));
}

/**
 * A recorded action is reported by identifier, because the caller needs to be
 * able to refer to the action it just created. Nothing else is emitted; the
 * reason code is fixed vocabulary and is rendered as safe display text.
 */
export function formatReviewAction(outcome: ReviewActionOutcome, redact: Redactor): string[] {
  const action = outcome.action;
  const head = outcome.outcome === 'recorded' ? 'recorded' : 'already recorded';
  return [
    `clustering:${action.operation}: ${head} action=${action.id} run=${action.clusteringRunId} revision=${action.resultingRevision} reason=${safeDisplay(action.reasonCode)} affectedIncidents=${action.affectedIncidentIds.length} affectedMemberships=${action.affectedMembershipIds.length}`,
  ].map((entry) => line(entry, redact));
}

/** Count-only summary of the effective view; never a member list. */
export function formatEffectiveView(view: EffectiveView, redact: Redactor): string[] {
  const merged = view.incidents.filter((incident) => incident.origin === 'merge').length;
  const split = view.incidents.filter((incident) => incident.origin === 'split').length;
  const largest = view.incidents.reduce(
    (biggest, incident) => Math.max(biggest, incident.membershipIds.length),
    0,
  );
  return [
    `clustering_effective run=${view.run.id} revision=${view.revision} incidents=${view.incidents.length} fromMerge=${merged} fromSplit=${split} largest=${largest}`,
  ].map((entry) => line(entry, redact));
}
