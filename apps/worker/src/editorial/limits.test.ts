import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RESOURCE_LIMITS, type ImportLimits } from '@cas/contracts';
import { createRedactor } from '@cas/database';
import { afterEach, describe, expect, it } from 'vitest';

import { IMPORT_LIMIT_CODES, readCsv, resolveImportLimits } from './csv-stream.js';
import { isIngestionError, type IngestionError } from './errors.js';
import { formatError } from './output.js';
import { validateCsvFile } from './validate.js';

/**
 * Adversarial tests of the import limits (`RESOURCE_LIMITS.import`).
 *
 * Every limit is exercised at its boundary minus one, at the exact bound and
 * at the bound plus one, with the limit lowered through the test hook so the
 * boundary can be reached with a few kilobytes. Every refusal must carry the
 * fixed message and numeric details only: the hostile marker planted in the
 * offending cell must appear nowhere in the error, its details or the line the
 * command would print. Cells are measured in UTF-8 bytes, which the
 * four-byte characters below make visibly different from string length.
 */

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A hostile value: an ANSI introducer, a would-be log line, and a marker that must never surface. */
const MARKER = 'SECRET-CELL-MARKER';
const HOSTILE = `${String.fromCharCode(0x1b)}[31m\nRECONCILIATION OK ${MARKER}`;

async function tempCsv(content: string | Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cas-limits-'));
  temps.push(dir);
  const file = path.join(dir, 'input.csv');
  await writeFile(file, content);
  return file;
}

function csv(rows: readonly (readonly string[])[]): string {
  return `${rows.map((row) => row.join(',')).join('\n')}\n`;
}

async function read(
  file: string,
  limits: Partial<ImportLimits>,
): Promise<{ header: readonly string[] | null; rows: number; error: IngestionError | null }> {
  let header: readonly string[] | null = null;
  let rows = 0;
  try {
    await readCsv(
      file,
      {
        onHeader: (cells) => {
          header = cells;
        },
        onRecord: () => {
          rows += 1;
        },
      },
      { limits },
    );
  } catch (error) {
    if (!isIngestionError(error)) throw error;
    return { header, rows, error };
  }
  return { header, rows, error: null };
}

function expectLimit(error: IngestionError | null, code: string, details: Record<string, number>) {
  if (error === null) throw new Error(`expected ${code}`);
  expect(error.kind).toBe('structural');
  expect(error.code).toBe(code);
  expect(error.message).toMatch(/^file rejected: /u);
  expect(error.details).toEqual(details);
  // Non-reflection: nothing of the input reaches the error or the printed line.
  const printed = formatError(error, createRedactor([]));
  for (const text of [error.message, JSON.stringify(error.details), printed]) {
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain('RECONCILIATION');
    expect(text).not.toContain(String.fromCharCode(0x1b));
  }
  expect(printed.split('\n')).toHaveLength(1);
  for (const value of Object.values(error.details)) expect(typeof value).toBe('number');
}

describe('import limits', () => {
  it('default to the versioned limits and refuse a non-positive override', () => {
    expect(resolveImportLimits()).toEqual(RESOURCE_LIMITS.import);
    expect(resolveImportLimits({ rowCount: 7 }).rowCount).toBe(7);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      let caught: unknown;
      try {
        resolveImportLimits({ cellBytes: bad });
      } catch (error) {
        caught = error;
      }
      if (!isIngestionError(caught)) throw new Error('expected a configuration error');
      expect(caught.kind).toBe('configuration');
      expect(caught.code).toBe('import_limit_invalid');
    }
    expect([...IMPORT_LIMIT_CODES]).toEqual([
      'limit_file_bytes',
      'limit_column_count',
      'limit_cell_bytes',
      'limit_row_count',
      'limit_retained_bytes',
      'limit_record_bytes',
    ]);
  });

  it('file bytes: accepts the exact bound and refuses one byte more', async () => {
    const content = csv([
      ['a', 'b'],
      ['1', HOSTILE.replace('\n', ' ')],
      ['2', 'y'],
    ]);
    const bytes = Buffer.byteLength(content, 'utf8');
    const file = await tempCsv(content);
    expect((await read(file, { fileBytes: bytes + 1 })).error).toBeNull();
    expect((await read(file, { fileBytes: bytes })).error).toBeNull();
    const refused = await read(file, { fileBytes: bytes - 1 });
    expectLimit(refused.error, 'limit_file_bytes', { limit: bytes - 1, observed: bytes });
  });

  it('file bytes: stops reading a large file at the first chunk that crosses the limit', async () => {
    // Twelve 64 KiB stream chunks of rows; the limit sits inside the third.
    const row = `1,${'x'.repeat(1000)}\n`;
    const content = `a,b\n${row.repeat(800)}`;
    const file = await tempCsv(content);
    const limit = 3 * 65_536 - 1;
    const refused = await read(file, { fileBytes: limit });
    if (refused.error === null) throw new Error('expected a refusal');
    expect(refused.error.code).toBe('limit_file_bytes');
    expect(refused.error.details['limit']).toBe(limit);
    // Observed is the count at the crossing chunk, never the whole file.
    expect(refused.error.details['observed']).toBeGreaterThan(limit);
    expect(refused.error.details['observed']).toBeLessThanOrEqual(limit + 65_536);
    expect(refused.error.details['observed']).toBeLessThan(Buffer.byteLength(content));
  });

  it('column count: accepts the exact bound and refuses one column more, before the header handler runs', async () => {
    const file = await tempCsv(
      csv([
        ['a', 'b', HOSTILE.replace('\n', ' ')],
        ['1', '2', '3'],
      ]),
    );
    expect((await read(file, { columnCount: 4 })).error).toBeNull();
    expect((await read(file, { columnCount: 3 })).error).toBeNull();
    const refused = await read(file, { columnCount: 2 });
    expectLimit(refused.error, 'limit_column_count', { limit: 2, observed: 3 });
    expect(refused.header).toBeNull();
    expect(refused.rows).toBe(0);
  });

  it('cell bytes: measures UTF-8 bytes, not string length, at the exact bound and one more', async () => {
    const face = String.fromCodePoint(0x1f600); // four bytes, two UTF-16 units
    const cell = face.repeat(256);
    expect(cell.length).toBe(512);
    expect(Buffer.byteLength(cell, 'utf8')).toBe(1024);
    const file = await tempCsv(
      csv([
        ['a', 'b'],
        ['1', `${cell}`],
        ['2', HOSTILE.replace('\n', ' ')],
      ]),
    );
    expect((await read(file, { cellBytes: 1025 })).error).toBeNull();
    expect((await read(file, { cellBytes: 1024 })).error).toBeNull();
    expectLimit((await read(file, { cellBytes: 1023 })).error, 'limit_cell_bytes', {
      limit: 1023,
      rowNumber: 1,
    });
    // A limit equal to the string length must still refuse: bytes are what count.
    expectLimit((await read(file, { cellBytes: 512 })).error, 'limit_cell_bytes', {
      limit: 512,
      rowNumber: 1,
    });
  });

  it('cell bytes: applies to header cells too, and names the header as row 0', async () => {
    const file = await tempCsv(
      csv([
        ['a', 'b'.repeat(40)],
        ['1', '2'],
      ]),
    );
    expect((await read(file, { cellBytes: 40 })).error).toBeNull();
    const refused = await read(file, { cellBytes: 39 });
    expectLimit(refused.error, 'limit_cell_bytes', { limit: 39, rowNumber: 0 });
    expect(refused.header).toBeNull();
  });

  it('row count: accepts the exact bound, refuses one row more, and delivers no row past the bound', async () => {
    const rows = [['a', 'b']];
    for (let i = 1; i <= 5; i += 1)
      rows.push([String(i), i === 4 ? HOSTILE.replace('\n', ' ') : 'v']);
    const file = await tempCsv(csv(rows));
    expect((await read(file, { rowCount: 6 })).error).toBeNull();
    const exact = await read(file, { rowCount: 5 });
    expect(exact.error).toBeNull();
    expect(exact.rows).toBe(5);
    const refused = await read(file, { rowCount: 4 });
    expectLimit(refused.error, 'limit_row_count', { limit: 4 });
    expect(refused.rows).toBe(4);
    const one = await read(file, { rowCount: 1 });
    expectLimit(one.error, 'limit_row_count', { limit: 1 });
    expect(one.rows).toBe(1);
  });

  it('retained bytes: sums data-row cell bytes, accepts the exact total and refuses one byte less', async () => {
    const face = String.fromCodePoint(0x1f600);
    const rows = [
      ['h1', 'h2'],
      ['1', face.repeat(10)], // 1 + 40 bytes
      ['22', 'plain'], // 2 + 5 bytes
      ['333', HOSTILE.replace('\n', ' ')],
    ];
    const total = rows
      .slice(1)
      .flat()
      .reduce((sum, cell) => sum + Buffer.byteLength(cell, 'utf8'), 0);
    const file = await tempCsv(csv(rows));
    expect((await read(file, { retainedBytes: total + 1 })).error).toBeNull();
    expect((await read(file, { retainedBytes: total })).error).toBeNull();
    const refused = await read(file, { retainedBytes: total - 1 });
    expectLimit(refused.error, 'limit_retained_bytes', { limit: total - 1, rowNumber: 3 });
    expect(refused.rows).toBe(2);
    // The header is not retained content and does not count.
    const headerBytes = Buffer.byteLength('h1h2', 'utf8');
    expect((await read(file, { retainedBytes: total })).error).toBeNull();
    expect(headerBytes).toBeGreaterThan(0);
  });

  it('record size: the parser refuses one oversized record with the fixed limit message', async () => {
    const file = await tempCsv(
      csv([
        ['a', 'b'],
        ['1', `${MARKER}${'x'.repeat(5000)}`],
      ]),
    );
    const refused = await read(file, { recordBytes: 1024 });
    expectLimit(refused.error, 'limit_record_bytes', { limit: 1024 });
    expect((await read(file, { recordBytes: 8192 })).error).toBeNull();
  });

  it('a hostile oversized cell never reaches the error, its details or the printed line', async () => {
    const hostile = `${HOSTILE}${'z'.repeat(2000)}`;
    const file = await tempCsv(
      csv([
        ['a', 'b'],
        ['1', `"${hostile.replace(/"/gu, '""')}"`],
      ]),
    );
    const refused = await read(file, { cellBytes: 100 });
    expectLimit(refused.error, 'limit_cell_bytes', { limit: 100, rowNumber: 1 });
  });

  it('the validation command inherits the limits and rejects before reporting anything', async () => {
    const file = await tempCsv(
      csv([
        ['ch', 'Date Posted', 'Date Updated', 'Title', 'URL'],
        ['', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', 'One', 'https://a.example/1'],
        ['', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', 'Two', 'https://a.example/2'],
      ]),
    );
    const report = await validateCsvFile(file, 'master', { limits: { rowCount: 2 } });
    expect(report.rows).toBe(2);
    let caught: unknown;
    try {
      await validateCsvFile(file, 'master', { limits: { rowCount: 1 } });
    } catch (error) {
      caught = error;
    }
    if (!isIngestionError(caught)) throw new Error('expected a refusal');
    expect(caught.code).toBe('limit_row_count');
  });

  it('reads the real-shaped synthetic master fixture under the versioned defaults', async () => {
    const fixture = new URL(
      '../../../../data/fixtures/editorial/master-synthetic.csv',
      import.meta.url,
    );
    const result = await read(fixture.pathname, {});
    expect(result.error).toBeNull();
    expect(result.rows).toBe(12);
  });
});
