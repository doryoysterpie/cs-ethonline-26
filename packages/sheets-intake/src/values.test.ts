import { describe, expect, it } from 'vitest';

import { buildRange, columnLetters, quoteTabName } from './a1.js';
import { isSheetsIntakeError } from './errors.js';
import { isFormulaLeading, normalizeCell, serialToInstant, sourceRowKey } from './values.js';
import { testLimits } from './test-support.js';

/**
 * Cell handling, range building and row identity.
 *
 * The formula cases matter because the workbook feeds an editorial pipeline
 * that ends in an export. A cell that begins with an equals sign is text here
 * and must still be text three systems later; the flag is what carries that
 * obligation forward.
 */

const limits = testLimits();

describe('a cell is inert data', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@import', '=HYPERLINK("https://example.invalid","x")'])(
    'flags %s as formula-leading and preserves it exactly',
    (raw) => {
      const cell = normalizeCell(raw, limits);
      expect(cell.kind).toBe('text');
      expect(cell.formulaLeading).toBe(true);
      // Flagged, not rewritten: the value survives byte for byte.
      expect(cell.raw).toBe(raw);
    },
  );

  it('flags tab and carriage return leaders, which some readers also evaluate', () => {
    for (const code of [0x09, 0x0d]) {
      expect(isFormulaLeading(`${String.fromCharCode(code)}=1+1`)).toBe(true);
    }
  });

  it('does not flag ordinary text that merely contains an operator', () => {
    for (const raw of ['a=b', 'Q1 2026 +3%', 'user@example.invalid', '']) {
      expect(normalizeCell(raw, limits).formulaLeading, raw).toBe(false);
    }
  });

  it('never evaluates anything: a formula-shaped string stays a string', () => {
    const cell = normalizeCell('=1+1', limits);
    expect(cell.raw).not.toBe('2');
    expect(cell.raw).toBe('=1+1');
  });

  it('maps the four documented value types and refuses anything else', () => {
    expect(normalizeCell(undefined, limits).kind).toBe('empty');
    expect(normalizeCell(null, limits).kind).toBe('empty');
    expect(normalizeCell('', limits).kind).toBe('empty');
    expect(normalizeCell('text', limits)).toMatchObject({ kind: 'text', raw: 'text' });
    expect(normalizeCell(42.5, limits)).toMatchObject({ kind: 'number', raw: '42.5' });
    expect(normalizeCell(true, limits)).toMatchObject({ kind: 'boolean', raw: 'TRUE' });
    for (const hostile of [{}, [], Symbol('x'), () => undefined]) {
      let caught: unknown;
      try {
        normalizeCell(hostile, limits);
      } catch (error) {
        caught = error;
      }
      expect(isSheetsIntakeError(caught) ? caught.code : '').toBe('cell_type_unexpected');
    }
  });

  it('refuses a non-finite number rather than coercing it', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      let caught: unknown;
      try {
        normalizeCell(value, limits);
      } catch (error) {
        caught = error;
      }
      expect(isSheetsIntakeError(caught) ? caught.code : '').toBe('cell_not_finite');
    }
  });

  it('refuses an oversized cell rather than truncating it', () => {
    let caught: unknown;
    try {
      normalizeCell('x'.repeat(101), testLimits({ maximumCellCharacters: 100 }));
    } catch (error) {
      caught = error;
    }
    expect(isSheetsIntakeError(caught) ? caught.code : '').toBe('cell_too_large');
    expect(isSheetsIntakeError(caught) ? caught.details['maximum'] : 0).toBe(100);
  });

  it('marks a cell that would need escaping to display', () => {
    expect(normalizeCell('a\nb', limits).requiresEscaping).toBe(true);
    expect(normalizeCell('ordinary', limits).requiresEscaping).toBe(false);
  });
});

describe('timestamps are normalized explicitly', () => {
  it('converts a serial number in the workbook zone', () => {
    // Serial 46194 is 2026-06-21. In Toronto that day starts at 04:00 UTC.
    expect(serialToInstant(46194, 'America/Toronto')).toBe('2026-06-21T04:00:00.000Z');
  });

  it('honours the daylight-saving boundary rather than assuming one offset', () => {
    const summer = serialToInstant(46194, 'America/Toronto');
    const winter = serialToInstant(46013, 'America/Toronto');
    expect(summer).toBe('2026-06-21T04:00:00.000Z');
    // 2025-12-22, when Toronto is five hours behind rather than four.
    expect(winter).toBe('2025-12-22T05:00:00.000Z');
  });

  it('reads a serial as a naive instant when the workbook declares no zone', () => {
    expect(serialToInstant(46194, null)).toBe('2026-06-21T00:00:00.000Z');
  });

  it('accepts an ISO string the workbook already normalized', () => {
    expect(serialToInstant('2026-06-21T12:00:00Z')).toBe('2026-06-21T12:00:00.000Z');
  });

  it('returns null rather than guessing for anything unreadable', () => {
    for (const value of ['', 'not a date', true, {}, -5, 1_000_000, Number.NaN]) {
      expect(serialToInstant(value, 'America/Toronto'), String(value)).toBeNull();
    }
  });

  it('returns null for an unknown zone rather than falling back to UTC', () => {
    expect(serialToInstant(46194, 'Not/AZone')).toBeNull();
  });
});

describe('row identity is derived, never positional', () => {
  const cells = [normalizeCell('a', limits), normalizeCell('b', limits)];
  const base = { workbookDigest: 'wb', tabDigest: 'tab', rowNumber: 5, cells };

  it('is stable across re-reads of the same row', () => {
    expect(sourceRowKey(base)).toBe(sourceRowKey({ ...base, cells: [...cells] }));
  });

  it('changes when the row moves', () => {
    expect(sourceRowKey({ ...base, rowNumber: 6 })).not.toBe(sourceRowKey(base));
  });

  it('changes when the content changes', () => {
    const changed = [normalizeCell('a', limits), normalizeCell('c', limits)];
    expect(sourceRowKey({ ...base, cells: changed })).not.toBe(sourceRowKey(base));
  });

  it('distinguishes the same content in different tabs and workbooks', () => {
    expect(sourceRowKey({ ...base, tabDigest: 'other' })).not.toBe(sourceRowKey(base));
    expect(sourceRowKey({ ...base, workbookDigest: 'other' })).not.toBe(sourceRowKey(base));
  });

  it('does not collide when the same characters are split differently', () => {
    const joined = [normalizeCell('ab', limits), normalizeCell('', limits)];
    const split = [normalizeCell('a', limits), normalizeCell('b', limits)];
    expect(sourceRowKey({ ...base, cells: joined })).not.toBe(
      sourceRowKey({ ...base, cells: split }),
    );
  });

  it('carries nothing reversible to the workbook identifier', () => {
    const key = sourceRowKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('wb');
  });
});

describe('A1 ranges are built, never concatenated', () => {
  it('quotes every tab name and doubles an internal quote', () => {
    expect(quoteTabName('Feed')).toBe("'Feed'");
    expect(quoteTabName("Owner's week")).toBe("'Owner''s week'");
  });

  it('refuses a name that could break out of the quoted section', () => {
    for (const title of [
      '',
      'x'.repeat(101),
      'a[b]',
      'a*b',
      'a?b',
      'a/b',
      `a${String.fromCharCode(0x1b)}b`,
    ]) {
      let caught: unknown;
      try {
        quoteTabName(title);
      } catch (error) {
        caught = error;
      }
      expect(isSheetsIntakeError(caught) ? caught.code : '', JSON.stringify(title)).toBe(
        'tab_name_unrepresentable',
      );
    }
  });

  it('builds a bounded range and never an open-ended one', () => {
    expect(buildRange({ title: 'Feed', firstRow: 2, lastRow: 501, columns: 8 })).toBe(
      "'Feed'!A2:H501",
    );
    // An injected name lands inside the quotes, not outside them.
    expect(buildRange({ title: "a'!ZZ999999", firstRow: 1, lastRow: 1, columns: 1 })).toBe(
      "'a''!ZZ999999'!A1:A1",
    );
  });

  it('converts column indexes past Z correctly', () => {
    expect(columnLetters(1)).toBe('A');
    expect(columnLetters(26)).toBe('Z');
    expect(columnLetters(27)).toBe('AA');
    expect(columnLetters(52)).toBe('AZ');
    expect(columnLetters(703)).toBe('AAA');
  });

  it('refuses an inverted or non-positive range', () => {
    for (const spec of [
      { title: 'Feed', firstRow: 0, lastRow: 5, columns: 1 },
      { title: 'Feed', firstRow: 5, lastRow: 4, columns: 1 },
      { title: 'Feed', firstRow: 1, lastRow: 1, columns: 0 },
    ]) {
      expect(() => buildRange(spec)).toThrowError();
    }
  });
});
