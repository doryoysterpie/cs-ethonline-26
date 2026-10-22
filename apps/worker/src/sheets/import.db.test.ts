import { randomUUID } from 'node:crypto';

import {
  countAllRows,
  countSheetsImportTimestamps,
  getSheetsImportRead,
  getSourceRows,
  isDatabaseError,
} from '@cas/database';
import { DEFAULT_LIMITS, normalizeCell, type ReadStats, type SourceRow } from '@cas/sheets-intake';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openMigratedSchema, type IsolatedSchema } from '../test-support.js';
import {
  persistSheetsBatch,
  prepareSheetsBatch,
  SERIAL_TRANSFORM,
  SHEETS_IMPORTER_VERSION,
  type FeedRead,
  type SheetsImportMapping,
} from './import.js';

/**
 * The persist half of the Sheets importer against an isolated, fully
 * migrated schema. The read is synthetic and in memory; what is proven is
 * the write: the batch record, every row through the importer's own path,
 * the read record, every converted serial bound to its stored row, the
 * idempotent second run, and the append-only guards of migration 0012.
 */

const MAPPING: SheetsImportMapping = {
  title: 'Synthetic feed',
  stage: 'rss_source_corpus',
  sourceKind: 'master',
  firstDataRow: 2,
  columns: 9,
  timestampColumns: [2, 3],
};
const HEADERS = [
  'ch',
  'Date Posted',
  'Date Updated',
  'Title',
  'Author',
  'Description',
  'Summary',
  'URL',
  'Category',
];
const GOOD = [
  true,
  46277.5,
  46037.395833333336,
  'Synthetic title one',
  '',
  '',
  '',
  'https://example.com/one',
  'synthetic',
];
const NO_TITLE = [false, 46277.5, 46277.5, '', '', '', '', 'https://example.com/two', 'synthetic'];
const WORKBOOK = 'a'.repeat(12);
const TAB = 'b'.repeat(12);

function row(rowNumber: number, values: readonly unknown[]): SourceRow {
  return {
    key: `key-${rowNumber}`,
    tabDisplayName: 'Synthetic feed',
    tabDigest: TAB,
    stage: 'rss_source_corpus',
    rowNumber,
    cells: values.map((value) => normalizeCell(value, DEFAULT_LIMITS)),
    observedAt: null,
    ingestedAt: '2026-10-21T00:00:00.000Z',
  };
}

function stats(rows: number): ReadStats {
  return {
    tabsRead: 1,
    rowsRead: rows,
    rowsEmitted: rows,
    rowsBlank: 0,
    pages: 1,
    cellsFormulaLeading: 0,
    cellsRequiringEscape: 0,
    timestampsNormalized: 0,
    timestampsUnreadable: 0,
    distinctKeys: rows,
  };
}

function feedRead(rows: readonly SourceRow[]): FeedRead {
  return {
    workbookDigest: WORKBOOK,
    tabDigest: TAB,
    tabTitle: 'Synthetic feed',
    timeZone: 'America/New_York',
    headerCells: HEADERS,
    rows,
    stats: stats(rows.length),
    warnings: [],
    readStartedAt: '2026-10-21T00:00:00.000Z',
    readCompletedAt: '2026-10-21T00:00:01.000Z',
  };
}

function prepare(read: FeedRead) {
  return prepareSheetsBatch({
    workbookDigest: read.workbookDigest,
    tabDigest: read.tabDigest,
    timeZone: read.timeZone,
    headerCells: read.headerCells,
    rows: read.rows,
    mapping: MAPPING,
  });
}

async function failsAsDatabaseError(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    return isDatabaseError(error);
  }
}

describe('persistSheetsBatch against an isolated migrated schema', () => {
  let isolated: IsolatedSchema;

  beforeAll(async () => {
    isolated = await openMigratedSchema();
  });

  afterAll(async () => {
    await isolated.close();
  });

  it('writes the batch, its rows, the read record and every converted serial, then repeats as a no-op', async () => {
    const read = feedRead([row(2, GOOD), row(3, NO_TITLE)]);
    const prepared = prepare(read);
    const first = await persistSheetsBatch(isolated.db, read, prepared, MAPPING);

    expect(first.outcome).toBe('imported');
    expect(first.batch.importerVersion).toBe(SHEETS_IMPORTER_VERSION);
    expect(first.batch.fileSha256).toBe(prepared.digest);
    expect(first.batch.idempotencyKey).toBe(prepared.idempotencyKey);
    expect(first.batch.sourceBasename).toBe('Synthetic feed');
    expect(first.batch.dataOrigin).toBe('live');
    expect(first.batch.sourceKind).toBe('master');
    expect(first.batch.reviewLabel).toBeNull();
    expect(first.batch.status).toBe('completed_with_issues');
    expect(first.batch.headerCells).toEqual(HEADERS);
    expect(first.storedRows).toEqual({ total: 2, accepted: 1, quarantined: 1 });
    expect(first.review).toBeNull();
    expect(first.sheets.rowsRead).toBe(2);
    expect(first.sheets.serialsConverted).toBe(4);

    const stored = await isolated.db.withClient((c) => getSourceRows(c, first.batch.id));
    expect(stored.map((r) => r.rowHash).sort()).toEqual(
      prepared.rows.map((r) => r.evaluation.rowHash).sort(),
    );
    const good = stored.find((r) => r.rowNumber === 2);
    expect(new Date(good?.postedAt ?? '').toISOString()).toBe('2026-09-12T16:00:00.000Z');
    expect(good?.rawCh).toBe('TRUE');

    const readRecord = await isolated.db.withClient((c) => getSheetsImportRead(c, first.batch.id));
    expect(readRecord).toMatchObject({
      batchId: first.batch.id,
      dataOrigin: 'live',
      workbookDigest: WORKBOOK,
      tabDigest: TAB,
      tabTitle: 'Synthetic feed',
      sheetTimeZone: 'America/New_York',
      serialTransform: SERIAL_TRANSFORM,
      rowsRead: 2,
      pages: 1,
    });
    expect(
      await isolated.db.withClient((c) => countSheetsImportTimestamps(c, first.batch.id)),
    ).toEqual({
      total: 4,
      converted: 4,
    });
    const serials = await isolated.db.withClient((c) =>
      c.query<{ column_index: number; serial_text: string; instant: string }>(
        `SELECT t.column_index, t.serial_text, to_json(t.instant) #>> '{}' AS instant
           FROM sheets_import_timestamps t JOIN source_rows r ON r.id = t.source_row_id
          WHERE t.batch_id = $1 AND r.row_number = 2 ORDER BY t.column_index`,
        [first.batch.id],
      ),
    );
    expect(serials.rows).toEqual([
      { column_index: 2, serial_text: '46277.5', instant: '2026-09-12T16:00:00+00:00' },
      { column_index: 3, serial_text: '46037.395833333336', instant: '2026-01-15T14:30:00+00:00' },
    ]);

    const before = await isolated.db.withClient(countAllRows);
    const second = await persistSheetsBatch(isolated.db, read, prepare(read), MAPPING);
    expect(second.outcome).toBe('already_imported');
    expect(second.batch.id).toBe(first.batch.id);
    expect(await isolated.db.withClient(countAllRows)).toEqual(before);
    expect(
      await isolated.db.withClient((c) => countSheetsImportTimestamps(c, first.batch.id)),
    ).toEqual({
      total: 4,
      converted: 4,
    });
  });

  it('keeps the provenance append-only and bound to the stored row', async () => {
    const read = feedRead([row(2, GOOD)]);
    const outcome = await persistSheetsBatch(isolated.db, read, prepare(read), MAPPING);
    const batchId = outcome.batch.id;
    expect(
      await failsAsDatabaseError(() =>
        isolated.db.withClient((c) =>
          c.query('UPDATE sheets_import_reads SET pages = 99 WHERE batch_id = $1', [batchId]),
        ),
      ),
    ).toBe(true);
    expect(
      await failsAsDatabaseError(() =>
        isolated.db.withClient((c) =>
          c.query('DELETE FROM sheets_import_timestamps WHERE batch_id = $1', [batchId]),
        ),
      ),
    ).toBe(true);
    const [stored] = await isolated.db.withClient((c) => getSourceRows(c, batchId));
    expect(stored).toBeDefined();
    // A serial that cites the right row under the wrong hash has no parent key.
    expect(
      await failsAsDatabaseError(() =>
        isolated.db.withClient((c) =>
          c.query(
            `INSERT INTO sheets_import_timestamps
               (id, batch_id, data_origin, source_row_id, row_hash, column_index, serial_text, instant)
             VALUES ($1, $2, 'live', $3, $4, 9, '1', NULL)`,
            [randomUUID(), batchId, stored?.id, 'f'.repeat(64)],
          ),
        ),
      ),
    ).toBe(true);
    // A read record can only ever be live.
    expect(
      await failsAsDatabaseError(() =>
        isolated.db.withClient((c) =>
          c.query(
            `INSERT INTO sheets_import_reads
               (batch_id, data_origin, workbook_digest, tab_digest, tab_title, sheet_time_zone,
                serial_transform, rows_read, pages, read_started_at, read_completed_at)
             VALUES ($1, 'fixture', $2, $3, 'x', NULL, 'sheets-serial-to-instant@1', 0, 0, now(), now())`,
            [randomUUID(), WORKBOOK, TAB],
          ),
        ),
      ),
    ).toBe(true);
  });
});
