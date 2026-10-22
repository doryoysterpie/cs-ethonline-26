/**
 * The Sheets-to-import bridge, pure part.
 *
 * Turns rows the connector read from the living feed tab into the exact row
 * evaluations the editorial importer writes, and computes the identity of
 * the batch they form. Nothing here opens a network connection or a
 * database handle: the connector reads, this module prepares, and the write
 * path (step 9 of CAS-001) persists. The design is `docs/CAS-001-REPORT.md`
 * section 1.
 *
 * Three rules are enforced here rather than documented:
 *
 *   - **Only the source corpus is intake.** A mapping whose stage is not
 *     `rss_source_corpus` is refused before any row is looked at. Weekly
 *     candidate tabs are calibration data, never intake (D31).
 *   - **A serial timestamp becomes a UTC instant under one versioned rule.**
 *     Sheets delivers dates as day counts in the workbook's zone; the importer
 *     accepts only strict timezone-aware ISO 8601. The conversion is named by
 *     `SERIAL_TRANSFORM`, carried in the importer version, and every converted
 *     serial is kept beside its instant for provenance.
 *   - **The batch is identified by what was read.** The digest covers the
 *     workbook and tab digests, the header row and every row's content in
 *     order, so an unchanged tab yields the same key and writes nothing, and
 *     any change yields a new batch.
 */
import { createHash } from 'node:crypto';

import type { EditorialSourceKind } from '@cas/contracts';
import { serialToInstant, type NormalizedCell, type SourceRow } from '@cas/sheets-intake';

import { IngestionError } from '../editorial/errors.js';
import { resolveHeaderLayout, type HeaderLayout } from '../editorial/headers.js';
import { TEXT_TRANSFORM } from '../editorial/html-text.js';
import { computeIdempotencyKey } from '../editorial/import.js';
import { evaluateRow, type RowEvaluation } from '../editorial/rows.js';

/** Names the Sheets transport and the serial rule. Part of every Sheets batch's idempotency key. */
export const SHEETS_IMPORTER_VERSION = 'editorial-sheets-import@1';
/** The serial-to-instant rule, named so a later change is a different batch. */
export const SERIAL_TRANSFORM = 'sheets-serial-to-instant@1';
/** Label under which a batch digest is computed. */
export const BATCH_DIGEST_LABEL = 'cas.sheets.batch.v1';

const INTAKE_STAGE = 'rss_source_corpus';
const MAXIMUM_COLUMNS = 64;

/** The committed declaration of the one tab this importer reads. Never inferred. */
export interface SheetsImportMapping {
  /** The tab's exact title. */
  readonly title: string;
  /** Must be the source corpus; anything else is refused. */
  readonly stage: string;
  /** The editorial source kind the batch is written as. */
  readonly sourceKind: EditorialSourceKind;
  /** One-based row where data starts; row 1 is the header. */
  readonly firstDataRow: number;
  /** Columns read from column A. */
  readonly columns: number;
  /** One-based columns whose numeric cells are serial timestamps. */
  readonly timestampColumns: readonly number[];
}

/** One serial cell and the instant it became, kept for provenance. */
export interface ConvertedSerial {
  readonly rowNumber: number;
  /** One-based column, as in the mapping. */
  readonly columnIndex: number;
  readonly serialText: string;
  /** `null` when the serial could not be converted; the row then carries a timestamp issue. */
  readonly instant: string | null;
}

export interface PreparedSheetsRow {
  readonly rowNumber: number;
  readonly evaluation: RowEvaluation;
  readonly serials: readonly ConvertedSerial[];
  /** Digest of the cells exactly as the connector normalized them, before any conversion. */
  readonly contentDigest: string;
}

export interface PreparedSheetsBatch {
  readonly importerVersion: string;
  readonly serialTransform: string;
  readonly headerCells: readonly string[];
  readonly layout: HeaderLayout;
  readonly rows: readonly PreparedSheetsRow[];
  /** SHA-256 over what was read; takes the place of the file hash in the batch record. */
  readonly digest: string;
  readonly idempotencyKey: string;
  /** UTF-8 bytes of every header and data cell read. */
  readonly byteLength: number;
  readonly counts: {
    readonly rows: number;
    readonly accepted: number;
    readonly quarantined: number;
    readonly serialsConverted: number;
    readonly serialsUnconvertible: number;
  };
}

export interface PrepareInput {
  readonly workbookDigest: string;
  readonly tabDigest: string;
  /** The workbook's declared zone; `null` means serials are read as UTC. */
  readonly timeZone: string | null;
  /** The header row's cells as read, blanks included. */
  readonly headerCells: readonly string[];
  readonly rows: readonly SourceRow[];
  readonly mapping: SheetsImportMapping;
}

function structural(code: string, message: string, details?: Record<string, number | string>) {
  return new IngestionError('structural', code, message, details);
}

/** Refuses a mapping that would make this importer read anything but the source corpus. */
export function assertSheetsImportMapping(mapping: SheetsImportMapping): void {
  if (mapping.stage !== INTAKE_STAGE) {
    throw structural(
      'mapping_stage_not_intake',
      'mapping rejected: only the source corpus stage is intake',
    );
  }
  if (mapping.sourceKind !== 'master') {
    throw structural(
      'mapping_kind_not_master',
      'mapping rejected: the feed tab is a master source',
    );
  }
  if (!Number.isInteger(mapping.firstDataRow) || mapping.firstDataRow < 2) {
    throw structural(
      'mapping_first_row_invalid',
      'mapping rejected: data must start below the header',
    );
  }
  if (
    !Number.isInteger(mapping.columns) ||
    mapping.columns < 1 ||
    mapping.columns > MAXIMUM_COLUMNS
  ) {
    throw structural('mapping_columns_invalid', 'mapping rejected: column count out of range', {
      maximum: MAXIMUM_COLUMNS,
    });
  }
  const seen = new Set<number>();
  for (const column of mapping.timestampColumns) {
    if (!Number.isInteger(column) || column < 1 || column > mapping.columns || seen.has(column)) {
      throw structural(
        'mapping_timestamp_column_invalid',
        'mapping rejected: a timestamp column is out of range or repeated',
      );
    }
    seen.add(column);
  }
}

const EMPTY: NormalizedCell = {
  kind: 'empty',
  raw: '',
  formulaLeading: false,
  requiresEscaping: false,
};

/**
 * The cells the row evaluator sees: every raw value as text, except that a
 * numeric cell in a declared timestamp column becomes its UTC instant. A
 * serial that cannot be converted is passed through as its text, so the
 * evaluator records `timestamp_invalid` rather than this module inventing a
 * value. A row wider than the mapping is refused: it means the tab's shape
 * changed under the declaration.
 */
export function importerCellsOf(
  cells: readonly NormalizedCell[],
  rowNumber: number,
  mapping: SheetsImportMapping,
  timeZone: string | null,
): { readonly cells: readonly string[]; readonly serials: readonly ConvertedSerial[] } {
  if (cells.length > mapping.columns) {
    throw structural('row_wider_than_mapping', 'row rejected: wider than the declared mapping', {
      rowNumber,
      width: cells.length,
      maximum: mapping.columns,
    });
  }
  const out: string[] = [];
  const serials: ConvertedSerial[] = [];
  const timestampColumns = new Set(mapping.timestampColumns);
  for (let index = 0; index < mapping.columns; index += 1) {
    const cell = cells[index] ?? EMPTY;
    const columnIndex = index + 1;
    if (timestampColumns.has(columnIndex) && cell.kind === 'number') {
      const instant = serialToInstant(Number(cell.raw), timeZone);
      serials.push({ rowNumber, columnIndex, serialText: cell.raw, instant });
      out.push(instant ?? cell.raw);
      continue;
    }
    out.push(cell.raw);
  }
  return { cells: out, serials };
}

/** Digest of a row's cells exactly as normalized, kind and text, before any conversion. */
export function rowContentDigest(cells: readonly NormalizedCell[]): string {
  return createHash('sha256')
    .update(JSON.stringify(cells.map((cell) => [cell.kind, cell.raw])))
    .digest('hex');
}

/** Digest of the whole read: workbook, tab, header and every row in order. */
export function computeBatchDigest(input: {
  readonly workbookDigest: string;
  readonly tabDigest: string;
  readonly headerCells: readonly string[];
  readonly rowDigests: readonly string[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        label: BATCH_DIGEST_LABEL,
        workbookDigest: input.workbookDigest,
        tabDigest: input.tabDigest,
        headerCells: input.headerCells,
        rowDigests: input.rowDigests,
      }),
    )
    .digest('hex');
}

function utf8Bytes(values: readonly string[]): number {
  let total = 0;
  for (const value of values) total += Buffer.byteLength(value, 'utf8');
  return total;
}

/**
 * Prepares one batch from rows the connector read. Pure: the same input
 * yields the same evaluations, digest and key, which is what makes the
 * idempotency check sound.
 */
export function prepareSheetsBatch(input: PrepareInput): PreparedSheetsBatch {
  assertSheetsImportMapping(input.mapping);
  const headerCells = [...input.headerCells];
  while (headerCells.length < input.mapping.columns) headerCells.push('');
  if (headerCells.length > input.mapping.columns) {
    throw structural(
      'header_wider_than_mapping',
      'header rejected: wider than the declared mapping',
      {
        width: headerCells.length,
        maximum: input.mapping.columns,
      },
    );
  }
  const layout = resolveHeaderLayout(headerCells);

  const rows: PreparedSheetsRow[] = [];
  const rowDigests: string[] = [];
  let byteLength = utf8Bytes(headerCells);
  let accepted = 0;
  let quarantined = 0;
  let serialsConverted = 0;
  let serialsUnconvertible = 0;

  for (const row of input.rows) {
    const converted = importerCellsOf(row.cells, row.rowNumber, input.mapping, input.timeZone);
    const evaluation = evaluateRow(
      row.rowNumber,
      converted.cells,
      layout,
      input.mapping.sourceKind,
    );
    const contentDigest = rowContentDigest(row.cells);
    byteLength += utf8Bytes(row.cells.map((cell) => cell.raw));
    if (evaluation.status === 'accepted') accepted += 1;
    else quarantined += 1;
    for (const serial of converted.serials) {
      if (serial.instant === null) serialsUnconvertible += 1;
      else serialsConverted += 1;
    }
    rows.push({ rowNumber: row.rowNumber, evaluation, serials: converted.serials, contentDigest });
    rowDigests.push(contentDigest);
  }

  const digest = computeBatchDigest({
    workbookDigest: input.workbookDigest,
    tabDigest: input.tabDigest,
    headerCells,
    rowDigests,
  });
  const idempotencyKey = computeIdempotencyKey({
    fileSha256: digest,
    sourceKind: input.mapping.sourceKind,
    origin: 'live',
    reviewLabel: null,
    importerVersion: SHEETS_IMPORTER_VERSION,
    textTransform: TEXT_TRANSFORM,
  });

  return {
    importerVersion: SHEETS_IMPORTER_VERSION,
    serialTransform: SERIAL_TRANSFORM,
    headerCells,
    layout,
    rows,
    digest,
    idempotencyKey,
    byteLength,
    counts: {
      rows: rows.length,
      accepted,
      quarantined,
      serialsConverted,
      serialsUnconvertible,
    },
  };
}
