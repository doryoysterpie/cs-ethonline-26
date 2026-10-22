import {
  DEFAULT_LIMITS,
  normalizeCell,
  type NormalizedCell,
  type SourceRow,
} from '@cas/sheets-intake';
import { describe, expect, it } from 'vitest';

import { isIngestionError } from '../editorial/errors.js';
import { TEXT_TRANSFORM } from '../editorial/html-text.js';
import { IMPORTER_VERSION as CSV_IMPORTER_VERSION } from '../editorial/constants.js';
import { computeIdempotencyKey } from '../editorial/import.js';
import {
  assertSheetsImportMapping,
  computeBatchDigest,
  evaluationContextOf,
  importerCellsOf,
  prepareSheetsBatch,
  rowContentDigest,
  SHEETS_IMPORTER_VERSION,
  type SheetsImportMapping,
} from './import.js';

/**
 * The reference implementation of CAS-001 step 7: a synthetic tab with the
 * living feed's shape and no real text, run through the pure bridge. Every
 * assertion is one claim of the design note (`docs/CAS-001-REPORT.md`,
 * section 1) made falsifiable.
 *
 * Serial constants: 46277.5 is 12 September 2026 at 12:00 in America/New_York,
 * which is 16:00 UTC; 46037.395833333336 is 15 January 2026 at 09:30 there,
 * which is 14:30 UTC. Both were computed independently of this code.
 */

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
] as const;

const MAPPING: SheetsImportMapping = {
  title: 'Synthetic feed',
  stage: 'rss_source_corpus',
  sourceKind: 'master',
  firstDataRow: 2,
  columns: 9,
  timestampColumns: [2, 3],
};

const WORKBOOK = 'a'.repeat(64);
const TAB = 'b'.repeat(64);
const ZONE = 'America/New_York';

function cells(values: readonly unknown[]): NormalizedCell[] {
  return values.map((value) => normalizeCell(value, DEFAULT_LIMITS));
}

function row(rowNumber: number, values: readonly unknown[]): SourceRow {
  return {
    key: `key-${rowNumber}`,
    tabDisplayName: 'Synthetic feed',
    tabDigest: TAB,
    stage: 'rss_source_corpus',
    rowNumber,
    cells: cells(values),
    observedAt: null,
    ingestedAt: '2026-10-21T00:00:00.000Z',
  };
}

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
const BAD_DATE = [
  true,
  'yesterday',
  46277.5,
  'Synthetic title three',
  '',
  '',
  '',
  'https://example.com/three',
  '',
];
const ISO_TEXT = [
  '',
  '2026-09-12T16:00:00Z',
  '2026-09-12T16:00:00Z',
  'Synthetic title four',
  '',
  '',
  '',
  'https://example.com/four',
  '',
];

function expectCode(run: () => unknown, code: string): void {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(isIngestionError(caught) && caught.code === code).toBe(true);
}

function prepare(rows: readonly SourceRow[], mapping: SheetsImportMapping = MAPPING) {
  return prepareSheetsBatch({
    workbookDigest: WORKBOOK,
    tabDigest: TAB,
    timeZone: ZONE,
    headerCells: [...HEADERS],
    rows,
    mapping,
  });
}

describe('mapping', () => {
  it('refuses any stage but the source corpus', () => {
    expect(() =>
      assertSheetsImportMapping({ ...MAPPING, stage: 'weekly_candidate_cut_down' }),
    ).toThrow(expect.objectContaining({ code: 'mapping_stage_not_intake' }));
  });

  it('refuses a timestamp column outside the declared width, or repeated', () => {
    for (const timestampColumns of [[10], [2, 2], [0]]) {
      let caught: unknown = null;
      try {
        assertSheetsImportMapping({ ...MAPPING, timestampColumns });
      } catch (error) {
        caught = error;
      }
      expect(isIngestionError(caught) && caught.code === 'mapping_timestamp_column_invalid').toBe(
        true,
      );
    }
  });
});

describe('header', () => {
  it("resolves the feed's nine headers with nothing unknown and nothing blank", () => {
    const batch = prepare([row(2, GOOD)]);
    expect(batch.layout.knownNames).toHaveLength(9);
    expect(batch.layout.unknownNames).toEqual([]);
    expect(batch.layout.blankPositions).toEqual([]);
  });

  it('refuses a header wider than the mapping', () => {
    expectCode(
      () =>
        prepareSheetsBatch({
          workbookDigest: WORKBOOK,
          tabDigest: TAB,
          timeZone: ZONE,
          headerCells: [...HEADERS, 'Extra'],
          rows: [],
          mapping: MAPPING,
        }),
      'header_wider_than_mapping',
    );
  });
});

describe('serial timestamps', () => {
  it("converts a serial in the workbook's zone to the UTC instant the importer accepts", () => {
    const batch = prepare([row(2, GOOD)]);
    const [prepared] = batch.rows;
    expect(prepared?.evaluation.issues).toEqual([]);
    expect(prepared?.evaluation.status).toBe('accepted');
    expect(prepared?.evaluation.postedAt).toBe('2026-09-12T16:00:00.000Z');
    expect(prepared?.evaluation.updatedAt).toBe('2026-01-15T14:30:00.000Z');
    expect(prepared?.serials).toEqual([
      { rowNumber: 2, columnIndex: 2, serialText: '46277.5', instant: '2026-09-12T16:00:00.000Z' },
      {
        rowNumber: 2,
        columnIndex: 3,
        serialText: '46037.395833333336',
        instant: '2026-01-15T14:30:00.000Z',
      },
    ]);
    expect(batch.counts.serialsConverted).toBe(2);
    expect(batch.counts.serialsUnconvertible).toBe(0);
  });

  it('reads serials as UTC when the workbook declares no zone', () => {
    const converted = importerCellsOf(cells(GOOD), 2, MAPPING, null);
    expect(converted.cells[1]).toBe('2026-09-12T12:00:00.000Z');
  });

  it('passes a strict ISO text timestamp through untouched', () => {
    const batch = prepare([row(5, ISO_TEXT)]);
    const [prepared] = batch.rows;
    expect(prepared?.evaluation.issues).toEqual([]);
    expect(new Date(prepared?.evaluation.postedAt ?? '').toISOString()).toBe(
      '2026-09-12T16:00:00.000Z',
    );
    expect(prepared?.serials).toEqual([]);
  });

  it('leaves a text value in a timestamp column to the evaluator, which quarantines the row', () => {
    const batch = prepare([row(4, BAD_DATE)]);
    const [prepared] = batch.rows;
    expect(prepared?.evaluation.status).toBe('quarantined');
    expect(prepared?.evaluation.issues.map((issue) => issue.code)).toContain('timestamp_invalid');
    expect(prepared?.serials).toHaveLength(1);
  });
});

describe('rows', () => {
  it('keeps a boolean ch as the TRUE or FALSE token the importer recognizes', () => {
    const batch = prepare([row(2, GOOD), row(3, NO_TITLE)]);
    expect(batch.rows[0]?.evaluation.raw.ch).toBe('TRUE');
    expect(batch.rows[1]?.evaluation.raw.ch).toBe('FALSE');
    expect(
      batch.rows[0]?.evaluation.issues.some((issue) => issue.code === 'ch_token_unrecognized'),
    ).toBe(false);
  });

  it('quarantines a row without a title and counts it', () => {
    const batch = prepare([row(2, GOOD), row(3, NO_TITLE)]);
    expect(batch.rows[1]?.evaluation.status).toBe('quarantined');
    expect(batch.counts).toEqual({
      rows: 2,
      accepted: 1,
      quarantined: 1,
      serialsConverted: 4,
      serialsUnconvertible: 0,
    });
  });

  it('pads a short row with empty cells and refuses a row wider than the mapping', () => {
    const short = importerCellsOf(cells([true, 46277.5, 46277.5, 'Short']), 2, MAPPING, ZONE);
    expect(short.cells).toHaveLength(9);
    expect(short.cells.slice(4)).toEqual(['', '', '', '', '']);
    expectCode(
      () => importerCellsOf(cells([...GOOD, 'extra']), 2, MAPPING, ZONE),
      'row_wider_than_mapping',
    );
  });

  it('counts the UTF-8 bytes of every header and data cell read', () => {
    const batch = prepare([row(2, GOOD)]);
    const expected =
      HEADERS.reduce((total, header) => total + Buffer.byteLength(header, 'utf8'), 0) +
      cells(GOOD).reduce((total, cell) => total + Buffer.byteLength(cell.raw, 'utf8'), 0);
    expect(batch.byteLength).toBe(expected);
  });
});

describe('batch identity', () => {
  it('is the same for the same read, twice', () => {
    const first = prepare([row(2, GOOD), row(3, NO_TITLE)]);
    const second = prepare([row(2, GOOD), row(3, NO_TITLE)]);
    expect(second.digest).toBe(first.digest);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('changes when one cell changes, and when two rows swap places', () => {
    const base = prepare([row(2, GOOD), row(3, NO_TITLE)]);
    const edited = prepare([
      row(2, [...GOOD.slice(0, 3), 'Synthetic title one, edited', ...GOOD.slice(4)]),
      row(3, NO_TITLE),
    ]);
    const swapped = prepare([row(2, NO_TITLE), row(3, GOOD)]);
    expect(edited.digest).not.toBe(base.digest);
    expect(swapped.digest).not.toBe(base.digest);
  });

  it('is computed over the connector-normalized cells, before any serial conversion', () => {
    const digest = rowContentDigest(cells(GOOD));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(rowContentDigest(cells([...GOOD.slice(0, 1), '46277.5', ...GOOD.slice(2)]))).not.toBe(
      digest,
    );
  });

  it('takes the place of the file hash in the importer key, under the Sheets importer version', () => {
    const batch = prepare([row(2, GOOD)]);
    const expected = computeIdempotencyKey({
      fileSha256: batch.digest,
      sourceKind: 'master',
      origin: 'live',
      reviewLabel: null,
      importerVersion: SHEETS_IMPORTER_VERSION,
      textTransform: TEXT_TRANSFORM,
    });
    expect(batch.idempotencyKey).toBe(expected);
    const asCsv = computeIdempotencyKey({
      fileSha256: batch.digest,
      sourceKind: 'master',
      origin: 'live',
      reviewLabel: null,
      importerVersion: CSV_IMPORTER_VERSION,
      textTransform: TEXT_TRANSFORM,
    });
    expect(batch.idempotencyKey).not.toBe(asCsv);
  });

  it('binds the digest to the workbook and the tab', () => {
    const rowDigests = [rowContentDigest(cells(GOOD))];
    const evaluation = evaluationContextOf(MAPPING, ZONE);
    const here = computeBatchDigest({
      workbookDigest: WORKBOOK,
      tabDigest: TAB,
      headerCells: [...HEADERS],
      rowDigests,
      evaluation,
    });
    const otherTab = computeBatchDigest({
      workbookDigest: WORKBOOK,
      tabDigest: 'c'.repeat(64),
      headerCells: [...HEADERS],
      rowDigests,
      evaluation,
    });
    expect(otherTab).not.toBe(here);
  });

  it('changes with the zone, the timestamp declaration and the width, which change the evaluation (audit F1)', () => {
    const rows = [row(2, GOOD)];
    const base = prepare(rows);
    const utc = prepareSheetsBatch({
      workbookDigest: WORKBOOK,
      tabDigest: TAB,
      timeZone: 'UTC',
      headerCells: [...HEADERS],
      rows,
      mapping: MAPPING,
    });
    const noTimestamps = prepare(rows, { ...MAPPING, timestampColumns: [] });
    const wider = prepareSheetsBatch({
      workbookDigest: WORKBOOK,
      tabDigest: TAB,
      timeZone: ZONE,
      headerCells: [...HEADERS, ''],
      rows,
      mapping: { ...MAPPING, columns: 10 },
    });
    // The evaluations really differ, so the identities must.
    expect(utc.rows[0]?.evaluation.postedAt).toBe('2026-09-12T12:00:00.000Z');
    expect(noTimestamps.rows[0]?.evaluation.status).toBe('quarantined');
    for (const other of [utc, noTimestamps, wider]) {
      expect(other.digest).not.toBe(base.digest);
      expect(other.idempotencyKey).not.toBe(base.idempotencyKey);
    }
  });
});
