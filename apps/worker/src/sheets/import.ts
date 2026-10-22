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
import { createHash, randomUUID } from 'node:crypto';

import type { EditorialSourceKind, ImportBatchStatus } from '@cas/contracts';
import {
  findImportBatchByIdempotencyKey,
  finalizeImportBatch,
  insertImportBatch,
  insertSheetsImportRead,
  insertSheetsImportTimestamps,
  listSourceRowIdentities,
  MAX_ROWS_PER_INSERT,
  type Database,
  type NewSheetsImportTimestamp,
} from '@cas/database';
import {
  buildRange,
  normalizeCell,
  readTab,
  serialToInstant,
  type EditorialStage,
  type NormalizedCell,
  type ReadStats,
  type SheetsLimits,
  type SheetsReadOnlyClient,
  type SourceRow,
} from '@cas/sheets-intake';

import { IngestionError } from '../editorial/errors.js';
import { resolveHeaderLayout, type HeaderLayout } from '../editorial/headers.js';
import { TEXT_TRANSFORM } from '../editorial/html-text.js';
import { computeIdempotencyKey } from '../editorial/import.js';
import { DEFAULT_CHUNK_SIZE } from '../editorial/constants.js';
import { describeBatch, writeEvaluations, type ImportOutcome } from '../editorial/import.js';
import { evaluateRow, type RowEvaluation } from '../editorial/rows.js';
import type { SheetsConnection } from './connect.js';

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

/** What one read of the feed tab produced, before any evaluation. */
export interface FeedRead {
  readonly workbookDigest: string;
  readonly tabDigest: string;
  readonly tabTitle: string;
  readonly timeZone: string | null;
  readonly headerCells: readonly string[];
  readonly rows: readonly SourceRow[];
  readonly stats: ReadStats;
  readonly warnings: readonly string[];
  readonly readStartedAt: string;
  readonly readCompletedAt: string;
}

export interface ReadFeedOptions {
  readonly limits: SheetsLimits;
  readonly workbookDigest: string;
  readonly now?: (() => Date) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Reads the declared feed tab exactly once: the workbook's structure, the
 * header row, then every data row page by page, held in memory. Nothing is
 * written. A tab that is not in the workbook, is not a grid, or holds no data
 * row is a refusal, never an empty batch.
 */
export async function readFeedTab(
  client: SheetsReadOnlyClient,
  mapping: SheetsImportMapping,
  options: ReadFeedOptions,
): Promise<FeedRead> {
  assertSheetsImportMapping(mapping);
  const now = options.now ?? (() => new Date());
  const readStartedAt = now().toISOString();
  const metadata = await client.metadata();
  const tab = metadata.tabs.find((candidate) => candidate.title === mapping.title);
  if (tab === undefined) {
    throw new IngestionError(
      'configuration',
      'tab_not_found',
      'no tab of that exact name exists in the workbook',
    );
  }
  if (tab.sheetType !== 'GRID') {
    throw structural('tab_not_grid', 'the declared tab is not a grid and cannot be read as rows');
  }
  const header = await client.values(
    buildRange({ title: tab.title, firstRow: 1, lastRow: 1, columns: mapping.columns }),
  );
  const headerCells = (header.values[0] ?? []).map(
    (value) => normalizeCell(value, options.limits).raw,
  );
  const outcome = await readTab(
    client,
    tab,
    {
      title: tab.title,
      stage: mapping.stage as EditorialStage,
      firstDataRow: mapping.firstDataRow,
      columns: mapping.columns,
    },
    {
      limits: options.limits,
      timeZone: metadata.timeZone,
      workbookDigest: options.workbookDigest,
      collectRows: true,
      now,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  const first = outcome.rows[0];
  if (first === undefined) {
    throw structural('feed_empty', 'the declared tab holds no data row; nothing to import');
  }
  return {
    workbookDigest: options.workbookDigest,
    tabDigest: first.tabDigest,
    tabTitle: tab.title,
    timeZone: metadata.timeZone,
    headerCells,
    rows: outcome.rows,
    stats: outcome.stats,
    warnings: outcome.warnings,
    readStartedAt,
    readCompletedAt: now().toISOString(),
  };
}

export interface SheetsImportOutcome extends ImportOutcome {
  readonly sheets: {
    readonly workbookDigest: string;
    readonly tabDigest: string;
    readonly tabTitle: string;
    readonly rowsRead: number;
    readonly pages: number;
    readonly serialsConverted: number;
    readonly serialsUnconvertible: number;
    readonly readStartedAt: string;
    readonly readCompletedAt: string;
  };
}

export interface PersistOptions {
  readonly now?: (() => Date) | undefined;
  readonly makeId?: (() => string) | undefined;
  readonly chunkSize?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Persists one prepared batch, or reports the batch an identical read
 * already produced. One transaction: the batch record, every row through the
 * importer's write path, the read record, every converted serial bound to its
 * stored row, then the batch's completion. Any failure rolls all of it back.
 */
export async function persistSheetsBatch(
  db: Database,
  read: FeedRead,
  prepared: PreparedSheetsBatch,
  mapping: SheetsImportMapping,
  options: PersistOptions = {},
): Promise<SheetsImportOutcome> {
  const now = options.now ?? (() => new Date());
  const makeId = options.makeId ?? randomUUID;
  const startedAt = now();
  const sheets = {
    workbookDigest: read.workbookDigest,
    tabDigest: read.tabDigest,
    tabTitle: read.tabTitle,
    rowsRead: read.stats.rowsRead,
    pages: read.stats.pages,
    serialsConverted: prepared.counts.serialsConverted,
    serialsUnconvertible: prepared.counts.serialsUnconvertible,
    readStartedAt: read.readStartedAt,
    readCompletedAt: read.readCompletedAt,
  };
  const existing = await db.withClient((client) =>
    findImportBatchByIdempotencyKey(client, prepared.idempotencyKey),
  );
  if (existing !== null) {
    const described = await describeBatch(db, existing.id);
    return {
      outcome: 'already_imported',
      ...described,
      durationMs: now().getTime() - startedAt.getTime(),
      sheets,
    };
  }
  const batchId = makeId();
  await db.withTransaction(async (tx) => {
    await insertImportBatch(tx, {
      id: batchId,
      dataOrigin: 'live',
      sourceKind: mapping.sourceKind,
      reviewLabel: null,
      sourceBasename: read.tabTitle,
      fileSha256: prepared.digest,
      byteLength: prepared.byteLength,
      headerCells: prepared.headerCells,
      importerVersion: prepared.importerVersion,
      idempotencyKey: prepared.idempotencyKey,
      startedAt: startedAt.toISOString(),
    });
    const counts = await writeEvaluations(
      { tx, batchId, snapshotId: null, origin: 'live', makeId },
      prepared.rows.map((row) => row.evaluation),
      options.chunkSize ?? DEFAULT_CHUNK_SIZE,
    );
    if (options.signal?.aborted === true) {
      throw new IngestionError('aborted', 'interrupted', 'import interrupted; batch rolled back');
    }
    const identities = new Map(
      (await listSourceRowIdentities(tx, batchId)).map((identity) => [
        identity.rowNumber,
        identity,
      ]),
    );
    const timestamps: NewSheetsImportTimestamp[] = [];
    for (const row of prepared.rows) {
      const identity = identities.get(row.rowNumber);
      if (identity === undefined || identity.rowHash !== row.evaluation.rowHash) {
        throw new IngestionError(
          'unexpected',
          'row_identity_mismatch',
          'a stored row does not match the row that was evaluated',
          { rowNumber: row.rowNumber },
        );
      }
      for (const serial of row.serials) {
        timestamps.push({
          id: makeId(),
          batchId,
          dataOrigin: 'live',
          sourceRowId: identity.id,
          rowHash: identity.rowHash,
          columnIndex: serial.columnIndex,
          serialText: serial.serialText,
          instant: serial.instant,
        });
      }
    }
    await insertSheetsImportRead(tx, {
      batchId,
      dataOrigin: 'live',
      workbookDigest: read.workbookDigest,
      tabDigest: read.tabDigest,
      tabTitle: read.tabTitle,
      sheetTimeZone: read.timeZone,
      serialTransform: prepared.serialTransform,
      rowsRead: read.stats.rowsRead,
      pages: read.stats.pages,
      readStartedAt: read.readStartedAt,
      readCompletedAt: read.readCompletedAt,
    });
    for (let index = 0; index < timestamps.length; index += MAX_ROWS_PER_INSERT) {
      await insertSheetsImportTimestamps(tx, timestamps.slice(index, index + MAX_ROWS_PER_INSERT));
    }
    const status: ImportBatchStatus =
      counts.quarantined > 0 ? 'completed_with_issues' : 'completed';
    await finalizeImportBatch(tx, {
      id: batchId,
      status,
      parsedRowCount: prepared.rows.length,
      acceptedRowCount: counts.accepted,
      quarantinedRowCount: counts.quarantined,
      completedAt: now().toISOString(),
    });
  });
  const described = await describeBatch(db, batchId);
  return {
    outcome: 'imported',
    ...described,
    durationMs: now().getTime() - startedAt.getTime(),
    sheets,
  };
}

/** Read once, prepare, persist: the whole `sheets import` command behind the command line. */
export async function importSheetsTab(
  db: Database,
  connection: SheetsConnection,
  mapping: SheetsImportMapping,
  options: PersistOptions = {},
): Promise<SheetsImportOutcome> {
  const read = await readFeedTab(connection.client, mapping, {
    limits: connection.config.limits,
    workbookDigest: connection.workbookDigest,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const prepared = prepareSheetsBatch({
    workbookDigest: read.workbookDigest,
    tabDigest: read.tabDigest,
    timeZone: read.timeZone,
    headerCells: read.headerCells,
    rows: read.rows,
    mapping,
  });
  return persistSheetsBatch(db, read, prepared, mapping, options);
}
