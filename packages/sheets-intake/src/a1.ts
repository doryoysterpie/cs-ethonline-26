import { fail } from './errors.js';

/**
 * A1 notation, built rather than concatenated.
 *
 * A tab name is workbook-controlled text. In A1 notation a name is wrapped in
 * single quotes, and a single quote inside the name is escaped by doubling it.
 * Concatenating an unescaped name into a range is the spreadsheet equivalent
 * of string-building a SQL query: a name containing a quote would end the
 * quoted section and let the rest of the name be read as range syntax.
 *
 * Two rules hold here. A tab name is always quoted, even when it looks like it
 * needs no quoting, so there is one code path rather than two. And a name that
 * cannot be represented safely is refused rather than repaired, because a
 * silently repaired name would address a different tab than the one the
 * inventory reported.
 */

/** The greatest column Google Sheets addresses. */
const MAXIMUM_COLUMN_INDEX = 18_278;

/** Characters that make a tab name unaddressable whatever the quoting. */
const STRUCTURAL_CHARACTERS = ['[', ']', '*', '?', '/'];

/** A tab name Google itself will not accept, or that cannot be quoted safely. */
function isUnrepresentable(title: string): boolean {
  if (title.length === 0 || title.length > 100) return true;
  if (STRUCTURAL_CHARACTERS.some((character) => title.includes(character))) return true;
  // A control character in a name could forge a line in any report that shows
  // the range, and can never be part of a legitimate tab name.
  return [...title].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
  });
}

/** Quotes a tab name for A1 notation, doubling any internal single quote. */
export function quoteTabName(title: string): string {
  if (isUnrepresentable(title)) {
    throw fail.structural(
      'tab_name_unrepresentable',
      'a tab name cannot be addressed safely in A1 notation and was refused',
      { length: title.length },
    );
  }
  return `'${title.split("'").join("''")}'`;
}

/** One-based column index to its letters: 1 becomes A, 27 becomes AA. */
export function columnLetters(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > MAXIMUM_COLUMN_INDEX) {
    throw fail.structural(
      'column_index_out_of_range',
      'a column index is outside the addressable range',
      { index },
    );
  }
  let remaining = index;
  let letters = '';
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

export interface RangeSpec {
  readonly title: string;
  /** One-based, inclusive. */
  readonly firstRow: number;
  /** One-based, inclusive. */
  readonly lastRow: number;
  /** Column count, counted from column A. */
  readonly columns: number;
}

/** Builds a bounded, fully qualified A1 range for one tab. */
export function buildRange(spec: RangeSpec): string {
  const { title, firstRow, lastRow, columns } = spec;
  if (!Number.isInteger(firstRow) || firstRow < 1) {
    throw fail.structural(
      'range_first_row_invalid',
      'a range start row is not a positive integer',
      {
        firstRow,
      },
    );
  }
  if (!Number.isInteger(lastRow) || lastRow < firstRow) {
    throw fail.structural('range_last_row_invalid', 'a range end row precedes its start row', {
      firstRow,
      lastRow,
    });
  }
  return `${quoteTabName(title)}!A${firstRow}:${columnLetters(columns)}${lastRow}`;
}
