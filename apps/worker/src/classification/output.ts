import type { Redactor } from '@cas/database';

import { safeDisplay, toSingleLine } from '../editorial/display.js';
import type { CalibrationReport, QueuePage, RunReport } from './report.js';
import type { ClassifyBatchOutcome } from './run.js';

/**
 * Formatting for the classification commands. The same rules as the
 * ingestion output: identifiers, versions, hashes, counts, statuses and fixed
 * vocabulary only. No title, URL, summary, description, raw field, path,
 * review label from a source row, or credential ever reaches a line.
 *
 * The one piece of untrusted metadata that can appear is the batch's review
 * label, which an operator supplied at import time; it is redacted and
 * rendered as safe single-line text exactly as the ingestion commands do.
 * Every returned entry is one physical line.
 */

function line(text: string, redact: Redactor): string {
  return toSingleLine(redact(text));
}

export function formatClassificationRun(outcome: ClassifyBatchOutcome, redact: Redactor): string[] {
  const run = outcome.run;
  const head =
    outcome.outcome === 'classified'
      ? `classification:run: classified run=${run.id}`
      : `classification:run: already classified as run=${run.id}; no results written`;
  return [
    `${head} batch=${run.batchId} origin=${run.dataOrigin} mode=${run.mode} status=${run.status}`,
    `versions: classifier=${run.classifierVersion} ruleset=${run.rulesetVersion} rulesetHash=${run.rulesetHash}`,
    `rows: expected=${run.expectedRowCount} classified=${run.classifiedRowCount}`,
    `decisions: include=${run.includeCount} exclude=${run.excludeCount} review=${run.reviewCount}`,
    `timing: started=${run.startedAt} completed=${run.completedAt} durationMs=${outcome.durationMs}`,
  ].map((entry) => line(entry, redact));
}

export function formatRunReport(report: RunReport, redact: Redactor): string[] {
  const run = report.run;
  const codes =
    report.rationaleCodes.length === 0
      ? 'none'
      : report.rationaleCodes.map((c) => `${c.code}=${c.count}`).join(' ');
  return [
    `classification:report: run=${run.id} batch=${run.batchId} origin=${run.dataOrigin} status=${run.status}`,
    `versions: classifier=${run.classifierVersion} ruleset=${run.rulesetVersion} rulesetHash=${run.rulesetHash}`,
    `counts: recorded expected=${run.expectedRowCount} classified=${run.classifiedRowCount} include=${run.includeCount} exclude=${run.excludeCount} review=${run.reviewCount}`,
    `stored: total=${report.stored.total} include=${report.stored.include} exclude=${report.stored.exclude} review=${report.stored.review}; unclassifiedRows=${report.unclassifiedRows}; reconciled=${report.reconciled ? 'yes' : 'NO'}`,
    `rationale codes: ${codes}`,
    `timing: started=${run.startedAt} completed=${run.completedAt}`,
  ].map((entry) => line(entry, redact));
}

export function formatQueue(page: QueuePage, redact: Redactor): string[] {
  const lines = [
    `classification:queue: run=${page.run.id} batch=${page.run.batchId} needsReview=${page.total} shown=${page.entries.length}${page.truncated ? ' (truncated)' : ''}`,
  ];
  for (const entry of page.entries) {
    lines.push(
      `  row=${entry.sourceRowId} rowNumber=${entry.rowNumber} score=${entry.signalScore} codes=${entry.rationaleCodes.join(',')}`,
    );
  }
  if (page.entries.length === 0) lines.push('  (queue empty for this run)');
  return lines.map((entry) => line(entry, redact));
}

export function formatCalibration(report: CalibrationReport, redact: Redactor): string[] {
  const m = report.metrics;
  const matrix = m.matrix
    .filter((cell) => cell.count > 0)
    .map((cell) => `${cell.decision}/${cell.reviewState}=${cell.count}`)
    .join(' ');
  return [
    `classification:calibrate: run=${report.run.id} batch=${report.run.batchId} label=${safeDisplay(redact(report.reviewLabel))} rulesetHash=${report.run.rulesetHash}`,
    `labelled rows: total=${m.total} selected=${m.byReviewState.selected} rejected=${m.byReviewState.rejected} unreviewed=${m.byReviewState.unreviewed}`,
    `decisions: include=${m.byDecision.include} exclude=${m.byDecision.exclude} review=${m.byDecision.review}`,
    `matrix: ${matrix.length === 0 ? 'empty' : matrix}`,
    `selected: total=${m.selected.total} include=${m.selected.include} review=${m.selected.review} exclude=${m.selected.exclude}`,
    `recall: selectedRetention=${m.selected.retentionRecall} strictInclude=${m.selected.strictIncludeRecall} target=0.98 met=${report.meetsTarget ? 'yes' : 'NO'}`,
    `queue: needsReview=${m.needsReviewCount} rate=${m.needsReviewRate} automationRate=${m.automationRate} includePrecisionAgainstSelected=${m.includePrecisionAgainstSelected}`,
  ].map((entry) => line(entry, redact));
}
