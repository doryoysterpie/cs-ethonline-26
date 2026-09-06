import path from 'node:path';

import type { EditorialSourceKind, ReviewState } from '@cas/contracts';

import { readCsv, type CsvStreamStats } from './csv-stream.js';
import { IngestionError } from './errors.js';
import { resolveHeaderLayout, type HeaderLayout } from './headers.js';
import { evaluateRow } from './rows.js';

/**
 * Validation without a database. `inspectCsvFile` is the structural pass:
 * header layout, logical row count, byte length and hash. `validateCsvFile`
 * additionally evaluates every row and aggregates count-only results. Both
 * reject the file on a structural fault and never write anywhere.
 */

export interface StructuralSummary extends CsvStreamStats {
  readonly basename: string;
  readonly headerCells: readonly string[];
  readonly layout: HeaderLayout;
  readonly rowCount: number;
}

export interface IssueCount {
  readonly code: string;
  readonly field: string | null;
  readonly severity: 'error' | 'warning';
  readonly count: number;
}

export interface ChCounts {
  readonly selectedToken: number;
  readonly rejectedToken: number;
  readonly blank: number;
  readonly other: number;
}

export interface ValidationReport {
  readonly structure: StructuralSummary;
  readonly sourceKind: EditorialSourceKind;
  readonly rows: number;
  readonly accepted: number;
  readonly quarantined: number;
  readonly issues: readonly IssueCount[];
  readonly chCounts: ChCounts;
  /** Weekly only: review states that would be recorded. `null` for master files. */
  readonly reviewCounts: Readonly<Record<ReviewState, number>> | null;
  readonly exactDuplicateExcess: number;
  readonly canonicalDuplicateExcess: number;
  readonly maxCellLength: number;
}

export interface ValidateOptions {
  readonly signal?: AbortSignal | undefined;
}

export async function inspectCsvFile(
  filePath: string,
  options: ValidateOptions = {},
): Promise<StructuralSummary> {
  let layout: HeaderLayout | null = null;
  let headerCells: readonly string[] = [];
  let rowCount = 0;
  const stats = await readCsv(
    filePath,
    {
      onHeader(cells) {
        headerCells = cells;
        layout = resolveHeaderLayout(cells);
      },
      onRecord() {
        rowCount += 1;
      },
    },
    { signal: options.signal },
  );
  if (layout === null) {
    throw new IngestionError('structural', 'header_missing', 'file rejected: no header row');
  }
  return { ...stats, basename: path.basename(filePath), headerCells, layout, rowCount };
}

/** Collision-free aggregation key built from plain source-safe characters. */
function issueKey(code: string, field: string | null, severity: string): string {
  return JSON.stringify([code, field, severity]);
}

export async function validateCsvFile(
  filePath: string,
  sourceKind: EditorialSourceKind,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  let layout: HeaderLayout | null = null;
  let headerCells: readonly string[] = [];
  let rows = 0;
  let accepted = 0;
  let quarantined = 0;
  let maxCellLength = 0;
  const issueCounts = new Map<string, IssueCount>();
  const ch = { selectedToken: 0, rejectedToken: 0, blank: 0, other: 0 };
  const review: Record<ReviewState, number> = { selected: 0, rejected: 0, unreviewed: 0 };
  const exact = new Map<string, number>();
  const canonical = new Map<string, number>();

  const stats = await readCsv(
    filePath,
    {
      onHeader(cells) {
        headerCells = cells;
        layout = resolveHeaderLayout(cells);
      },
      onRecord(rowNumber, cells) {
        if (layout === null) return;
        rows += 1;
        for (const cell of cells) if (cell.length > maxCellLength) maxCellLength = cell.length;
        const evaluation = evaluateRow(rowNumber, cells, layout, sourceKind);
        if (evaluation.status === 'accepted') accepted += 1;
        else quarantined += 1;
        for (const item of evaluation.issues) {
          const key = issueKey(item.code, item.field, item.severity);
          const existing = issueCounts.get(key);
          issueCounts.set(
            key,
            existing === undefined
              ? { code: item.code, field: item.field, severity: item.severity, count: 1 }
              : { ...existing, count: existing.count + 1 },
          );
        }
        const token = (evaluation.raw.ch ?? '').trim();
        if (token === 'TRUE') ch.selectedToken += 1;
        else if (token === 'FALSE') ch.rejectedToken += 1;
        else if (token.length === 0) ch.blank += 1;
        else ch.other += 1;
        if (evaluation.review !== null) review[evaluation.review.state] += 1;
        if (evaluation.raw.url !== null) {
          exact.set(evaluation.raw.url, (exact.get(evaluation.raw.url) ?? 0) + 1);
        }
        if (evaluation.canonicalUrl !== null) {
          canonical.set(evaluation.canonicalUrl, (canonical.get(evaluation.canonicalUrl) ?? 0) + 1);
        }
      },
    },
    { signal: options.signal },
  );
  if (layout === null) {
    throw new IngestionError('structural', 'header_missing', 'file rejected: no header row');
  }
  const excess = (counts: Map<string, number>): number =>
    [...counts.values()].reduce((sum, n) => sum + (n > 1 ? n - 1 : 0), 0);
  const issues = [...issueCounts.values()].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : (a.field ?? '') < (b.field ?? '') ? -1 : 1,
  );
  return {
    structure: { ...stats, basename: path.basename(filePath), headerCells, layout, rowCount: rows },
    sourceKind,
    rows,
    accepted,
    quarantined,
    issues,
    chCounts: ch,
    reviewCounts: sourceKind === 'weekly' ? review : null,
    exactDuplicateExcess: excess(exact),
    canonicalDuplicateExcess: excess(canonical),
    maxCellLength,
  };
}
