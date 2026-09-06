import { isDatabaseError, type IssueCodeCount, type Redactor } from '@cas/database';

import { safeDisplay, toSingleLine } from './display.js';
import { isIngestionError } from './errors.js';
import type { ImportOutcome } from './import.js';
import type { BatchReport } from './report.js';
import type { IssueCount, ValidationReport } from './validate.js';

/**
 * Every line the command-line interface prints is assembled here from safe
 * values only: hashes, counts, row numbers, statuses, durations, issue codes,
 * known header names and fixed messages, plus two pieces of untrusted
 * metadata, the file basename and the review label. Those two pass through
 * the redactor first and then through `safeDisplay`, so a secret hidden in a
 * filename is removed before any control character is escaped and neither can
 * forge a line. Every returned entry is exactly one physical line. Unknown
 * header names are reported as a count. Nothing here receives a title, URL,
 * summary, description, raw row or absolute path.
 */

const KNOWN_FIELDS = new Set([
  'ch',
  'Date Posted',
  'Date Updated',
  'Title',
  'Author',
  'Description',
  'Summary',
  'URL',
  'Category',
]);

function safeField(field: string | null): string {
  if (field === null) return '-';
  return KNOWN_FIELDS.has(field) ? field : 'unknown-field';
}

/** Untrusted metadata: redact, then escape and bound. `null` prints as `-`. */
function metadata(value: string | null, redact: Redactor): string {
  return value === null ? '-' : safeDisplay(redact(value));
}

/** Final guard on a composed line: redact again, then force one physical line. */
function finalLine(line: string, redact: Redactor): string {
  return toSingleLine(redact(line));
}

function formatIssueCounts(issues: readonly (IssueCount | IssueCodeCount)[]): string {
  if (issues.length === 0) return 'none';
  return issues
    .map((issue) => {
      const code = 'code' in issue ? issue.code : issue.issueCode;
      return `${code}[${safeField(issue.field)}/${issue.severity}]=${issue.count}`;
    })
    .join(' ');
}

export function formatValidation(report: ValidationReport, redact: Redactor): string[] {
  const s = report.structure;
  const lines = [
    `editorial:validate: structure OK; file=${metadata(s.basename, redact)}; kind=${report.sourceKind}; bytes=${s.byteLength}; sha256=${s.sha256}; bom=${s.bom ? 'yes' : 'no'}`,
    `header: cells=${s.headerCells.length} named=${s.layout.named.size} known=${s.layout.knownNames.length} unknown=${s.layout.unknownNames.length} blank=${s.layout.blankPositions.length}`,
    `rows: parsed=${report.rows} accepted=${report.accepted} quarantined=${report.quarantined} maxCellLength=${report.maxCellLength}`,
    `issues: ${formatIssueCounts(report.issues)}`,
    `ch tokens: TRUE=${report.chCounts.selectedToken} FALSE=${report.chCounts.rejectedToken} blank=${report.chCounts.blank} other=${report.chCounts.other}`,
    `duplicates: exactUrlExcess=${report.exactDuplicateExcess} canonicalUrlExcess=${report.canonicalDuplicateExcess}`,
  ];
  if (report.reviewCounts !== null) {
    lines.push(
      `weekly review (not written by validate): selected=${report.reviewCounts.selected} rejected=${report.reviewCounts.rejected} unreviewed=${report.reviewCounts.unreviewed}`,
    );
  } else {
    lines.push('master ch is working state: no review state derived');
  }
  lines.push(
    `result: ${report.quarantined > 0 ? 'would complete with issues' : 'would complete cleanly'}; no database write performed`,
  );
  return lines.map((line) => finalLine(line, redact));
}

function formatReview(review: ImportOutcome['review'], redact: Redactor): string {
  if (review === null) return 'review snapshot: none (master import)';
  const counts = review.entries.map((e) => `${e.reviewState}=${e.count}`).join(' ');
  return `review snapshot: label=${metadata(review.reviewLabel, redact)} entries: ${counts.length > 0 ? counts : 'none'}; entriesOnQuarantinedRows=${review.entriesOnQuarantinedRows}`;
}

export function formatImportOutcome(outcome: ImportOutcome, redact: Redactor): string[] {
  const b = outcome.batch;
  const head =
    outcome.outcome === 'imported'
      ? `editorial:import: imported batch=${b.id}`
      : `editorial:import: already imported as batch=${b.id}; no rows written`;
  const lines = [
    `${head} status=${b.status} kind=${b.sourceKind} origin=${b.dataOrigin} label=${metadata(b.reviewLabel, redact)} file=${metadata(b.sourceBasename, redact)} sha256=${b.fileSha256} bytes=${b.byteLength}`,
    `rows: parsed=${b.parsedRowCount} accepted=${b.acceptedRowCount} quarantined=${b.quarantinedRowCount}; stored total=${outcome.storedRows.total} accepted=${outcome.storedRows.accepted} quarantined=${outcome.storedRows.quarantined}`,
    `issues: ${formatIssueCounts(outcome.issues)}`,
    formatReview(outcome.review, redact),
    `url groups: rowsWithGroup=${outcome.urlGroups.rowsWithGroup} distinctGroups=${outcome.urlGroups.distinctGroups} duplicateExcess=${outcome.urlGroups.duplicateExcess}`,
    `timing: started=${b.startedAt} completed=${b.completedAt ?? '-'} durationMs=${outcome.durationMs}`,
  ];
  return lines.map((line) => finalLine(line, redact));
}

export function formatBatchReport(report: BatchReport, redact: Redactor): string[] {
  const b = report.batch;
  const lines = [
    `batch=${b.id} status=${b.status} kind=${b.sourceKind} origin=${b.dataOrigin} label=${metadata(b.reviewLabel, redact)} file=${metadata(b.sourceBasename, redact)} sha256=${b.fileSha256} bytes=${b.byteLength} importer=${b.importerVersion}`,
    `  counts: recorded parsed=${b.parsedRowCount} accepted=${b.acceptedRowCount} quarantined=${b.quarantinedRowCount}; stored total=${report.stored.total} accepted=${report.stored.accepted} quarantined=${report.stored.quarantined}; reconciled=${report.reconciled ? 'yes' : 'NO'}`,
    `  issues: ${formatIssueCounts(report.issues)}`,
    `  ${formatReview(report.review, redact)}`,
    `  url groups: rowsWithGroup=${report.urlGroups.rowsWithGroup} distinctGroups=${report.urlGroups.distinctGroups} duplicateExcess=${report.urlGroups.duplicateExcess}`,
    `  timing: started=${b.startedAt} completed=${b.completedAt ?? '-'}`,
  ];
  return lines.map((line) => finalLine(line, redact));
}

function formatDetails(
  details: Readonly<Record<string, string | number | boolean | null>>,
): string {
  const entries = Object.entries(details).filter(([, value]) => value !== null);
  if (entries.length === 0) return '';
  return ` (${entries.map(([key, value]) => `${key}=${String(value)}`).join(', ')})`;
}

/** Fixed message, kind, code and safe details only, redacted and forced to one line. */
export function formatError(error: unknown, redact: Redactor): string {
  let line: string;
  if (isIngestionError(error)) {
    line = `error[${error.kind}/${error.code}]: ${error.message}${formatDetails(error.details)}`;
  } else if (isDatabaseError(error)) {
    line = `error[database:${error.kind}${error.code === null ? '' : `/${error.code}`}]: ${error.message}${formatDetails(error.details)}`;
  } else if (error instanceof Error) {
    line = `error[unexpected]: ${error.name}`;
  } else {
    line = 'error[unexpected]: non-error value thrown';
  }
  return finalLine(line, redact);
}
