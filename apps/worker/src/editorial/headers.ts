import { KNOWN_HEADERS, REQUIRED_HEADERS, type KnownHeader } from './constants.js';
import { IngestionError } from './errors.js';

/**
 * Header resolution. Known fields are recognized by exact normalized header
 * name (Unicode NFC, surrounding whitespace trimmed), never by position.
 * Blank headers are accepted at any position, because weekly sheets carry
 * trailing blank columns; their cells stay in the ordered raw cell list and
 * are never mapped to a named field. A duplicated non-blank header or a
 * missing required header rejects the file before any write.
 */

export interface HeaderLayout {
  /** Exact header cells as read, in order, blanks included. */
  readonly cells: readonly string[];
  /** Normalized name per position, `null` for a blank header. */
  readonly names: readonly (string | null)[];
  /** Normalized non-blank name to its position. */
  readonly named: ReadonlyMap<string, number>;
  readonly blankPositions: readonly number[];
  readonly knownNames: readonly KnownHeader[];
  /** Non-blank headers that are not known. Retained in raw fields; never printed. */
  readonly unknownNames: readonly string[];
}

const KNOWN = new Set<string>(KNOWN_HEADERS);

export function normalizeHeaderName(cell: string): string {
  return cell.normalize('NFC').trim();
}

export function resolveHeaderLayout(cells: readonly string[]): HeaderLayout {
  const names = cells.map((cell) => {
    const name = normalizeHeaderName(cell);
    return name.length === 0 ? null : name;
  });
  const named = new Map<string, number>();
  const blankPositions: number[] = [];
  let duplicates = 0;
  names.forEach((name, index) => {
    if (name === null) {
      blankPositions.push(index);
      return;
    }
    if (named.has(name)) duplicates += 1;
    else named.set(name, index);
  });
  if (named.size === 0) {
    throw new IngestionError(
      'structural',
      'header_empty',
      'file rejected: header has no named column',
    );
  }
  if (duplicates > 0) {
    throw new IngestionError(
      'structural',
      'header_duplicate',
      `file rejected: ${duplicates} duplicated non-blank header name(s)`,
      { duplicates },
    );
  }
  const missing = REQUIRED_HEADERS.filter((name) => !named.has(name));
  if (missing.length > 0) {
    throw new IngestionError(
      'structural',
      'header_required_missing',
      `file rejected: required header(s) missing: ${missing.join(', ')}`,
      { missing: missing.join(','), missingCount: missing.length },
    );
  }
  const knownNames = KNOWN_HEADERS.filter((name) => named.has(name));
  const unknownNames = [...named.keys()].filter((name) => !KNOWN.has(name));
  return { cells, names, named, blankPositions, knownNames, unknownNames };
}

/** The exact cell under a known header, or `null` when the header is absent from the file. */
export function cellFor(
  layout: HeaderLayout,
  record: readonly string[],
  header: KnownHeader,
): string | null {
  const index = layout.named.get(header);
  if (index === undefined) return null;
  return record[index] ?? '';
}
