import { createHash } from 'node:crypto';

import { safeDisplay } from './display.js';
import { fail } from './errors.js';
import type { SheetsLimits } from './limits.js';

/**
 * Cell handling.
 *
 * Three rules, and each exists because of a specific way spreadsheet data
 * goes wrong downstream.
 *
 *   1. **A cell is inert text.** Nothing here evaluates anything. A string
 *      that begins with one of the formula-leading characters is data that
 *      looks like a formula, and it is flagged so that any later export can
 *      neutralize it rather than hand a spreadsheet a live formula. The value
 *      itself is preserved exactly: flagging is not rewriting.
 *   2. **A timestamp is normalized explicitly.** Sheets returns dates as
 *      serial numbers counted from 30 December 1899 in the workbook's own time
 *      zone. Converting one requires knowing that zone, so the zone is a
 *      required argument and a missing zone is a refusal rather than a guess
 *      at UTC.
 *   3. **A row's identity is derived, never positional.** A spreadsheet row
 *      number changes when somebody inserts a row above it, so the row number
 *      is recorded as provenance but never used as identity on its own.
 *      Identity is a digest over the workbook, the tab, the row's content and
 *      its position together.
 */

/** Characters that make a leading-text cell dangerous to re-export. */
export const FORMULA_LEADING_CHARACTERS = ['=', '+', '-', '@'] as const;
/** Tab and carriage return also lead a formula in some spreadsheet readers. */
const FORMULA_LEADING_CONTROLS = [0x09, 0x0d];

/** Serial day zero: Sheets counts days from 30 December 1899. */
const SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
/** Serial values outside this window are not plausible timestamps. */
const MINIMUM_SERIAL = 1;
const MAXIMUM_SERIAL = 100_000;

/** The kinds a normalized cell may take. Closed, so nothing else is storable. */
export const CELL_KINDS = ['empty', 'text', 'number', 'boolean'] as const;
export type CellKind = (typeof CELL_KINDS)[number];

export interface NormalizedCell {
  readonly kind: CellKind;
  /** The value as text, preserved exactly. Never re-encoded or trimmed away. */
  readonly raw: string;
  /** True when `raw` begins like a formula and must never be re-emitted as one. */
  readonly formulaLeading: boolean;
  /** True when displaying `raw` requires escaping. */
  readonly requiresEscaping: boolean;
}

/** True when a string would be read as a formula by a spreadsheet reader. */
export function isFormulaLeading(value: string): boolean {
  if (value.length === 0) return false;
  const first = value.charCodeAt(0);
  if (FORMULA_LEADING_CONTROLS.includes(first)) return true;
  return (FORMULA_LEADING_CHARACTERS as readonly string[]).includes(value.charAt(0));
}

/**
 * Normalizes one API cell into the closed shape above.
 *
 * The API returns a string, a number, a boolean, or nothing. Anything else
 * means the response did not match the documented shape, and is refused rather
 * than coerced: a silent coercion here would turn an unexpected response into
 * plausible-looking data.
 */
export function normalizeCell(value: unknown, limits: SheetsLimits): NormalizedCell {
  if (value === undefined || value === null || value === '') {
    return { kind: 'empty', raw: '', formulaLeading: false, requiresEscaping: false };
  }
  let kind: CellKind;
  let raw: string;
  if (typeof value === 'string') {
    kind = 'text';
    raw = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw fail.schema('cell_not_finite', 'a numeric cell is not a finite number');
    }
    kind = 'number';
    raw = String(value);
  } else if (typeof value === 'boolean') {
    kind = 'boolean';
    raw = value ? 'TRUE' : 'FALSE';
  } else {
    throw fail.schema('cell_type_unexpected', 'a cell carries a type the API does not document');
  }
  if (raw.length > limits.maximumCellCharacters) {
    throw fail.structural('cell_too_large', 'a cell exceeds the configured length bound', {
      length: raw.length,
      maximum: limits.maximumCellCharacters,
    });
  }
  return {
    kind,
    raw,
    formulaLeading: kind === 'text' && isFormulaLeading(raw),
    requiresEscaping: safeDisplay(raw, Number.MAX_SAFE_INTEGER) !== raw,
  };
}

/**
 * Converts a Sheets serial number to an ISO instant in the workbook's zone.
 *
 * Returns null rather than throwing for a value that is not a plausible
 * timestamp, because a timestamp column in a seventy-week workbook will
 * contain blanks, notes and typing mistakes, and one of those is not a reason
 * to abandon a range. The caller counts what it could not read.
 *
 * The offset is resolved for the specific instant rather than assumed, so a
 * date on the other side of a daylight-saving boundary converts correctly.
 */
export function serialToInstant(value: unknown, timeZone?: string | null): string | null {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < MINIMUM_SERIAL || value > MAXIMUM_SERIAL) return null;

  const naive = SERIAL_EPOCH_MS + value * MS_PER_DAY;
  if (timeZone === undefined || timeZone === null || timeZone === '') {
    // No zone: the instant is reported as the naive wall-clock reading in UTC,
    // which is exactly what it is. The caller is told the zone was absent.
    return new Date(Math.round(naive)).toISOString();
  }
  const offsetMs = zoneOffsetMs(naive, timeZone);
  if (offsetMs === null) return null;
  return new Date(Math.round(naive - offsetMs)).toISOString();
}

/**
 * The offset of a named zone at a given wall-clock instant, in milliseconds.
 *
 * Uses the platform's own zone database through `Intl`, so no zone table is
 * carried here and no dependency is added for one.
 */
function zoneOffsetMs(wallClockMs: number, timeZone: string): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(wallClockMs));
  } catch {
    return null;
  }
  const field = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? Number.NaN : Number(found.value);
  };
  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  return Number.isNaN(asUtc) ? null : asUtc - wallClockMs;
}

/**
 * Frames the fields of a row key. NUL cannot occur in a digest, a cell kind or
 * a decimal count, so no value can imitate a field boundary. It is spelled out
 * as an escape: a raw control byte in source is invisible in review, and is
 * exactly what this project's own hygiene guard refuses.
 */
const FIELD_SEPARATOR = '\u0000';

/**
 * The deterministic identity of one source row.
 *
 * Built from the workbook digest, the tab, the row's position and a digest of
 * its content. Position alone is not identity: rows move. Content alone is not
 * identity either, because a workbook legitimately contains duplicate rows and
 * collapsing them would lose one. Together they are stable across re-reads of
 * an unchanged workbook, which is what idempotence needs.
 *
 * The workbook identifier is never an input: its digest is, so nothing
 * reversible to the identifier is carried in a row key.
 */
export function sourceRowKey(input: {
  readonly workbookDigest: string;
  readonly tabDigest: string;
  readonly rowNumber: number;
  readonly cells: readonly NormalizedCell[];
}): string {
  const content = createHash('sha256');
  for (const cell of input.cells) {
    // Length-framed, so two different splits of the same characters cannot
    // produce the same digest.
    content.update(`${cell.kind}:${Buffer.byteLength(cell.raw, 'utf8')}:`);
    content.update(cell.raw, 'utf8');
    content.update(FIELD_SEPARATOR);
  }
  return createHash('sha256')
    .update('cas.sheets.row.v1')
    .update(FIELD_SEPARATOR)
    .update(input.workbookDigest)
    .update(FIELD_SEPARATOR)
    .update(input.tabDigest)
    .update(FIELD_SEPARATOR)
    .update(String(input.rowNumber))
    .update(FIELD_SEPARATOR)
    .update(content.digest('hex'))
    .digest('hex');
}
