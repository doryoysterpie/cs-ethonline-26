import { escapeOneLine, escapedCut } from '@cas/contracts';

/**
 * Safe single-line display of workbook-controlled values.
 *
 * A tab name, a header cell and an API error message are all authored by
 * someone other than this program. Any of them may carry newlines, carriage
 * returns, ANSI escape introducers or Unicode line separators, and any of
 * those could forge a line in a report that a human reads as this program's
 * own output. `safeDisplay` renders such a value as exactly one line, with
 * every character the prohibited-text rule names, and tab, line feed and
 * carriage return, shown as a visible escape in the one form (`\u{001B}`, D50;
 * `@cas/contracts`), so the formatter's own line breaks are the only line
 * breaks in the output. `hasControlCharacter` keeps the controls and the
 * separators, the set its callers refuse.
 *
 * The underlying value is never mutated; only the display copy is transformed.
 * This mirrors the identical guard in `@cas/graph-evidence` and the worker's
 * editorial display, because the hazard is the same one.
 */

const char = (code: number): string => String.fromCharCode(code);

/** ASCII escape, the introducer of ANSI sequences. */
export const ESCAPE_CHARACTER = char(0x1b);

// The controls (`\p{Cc}`: C0, DEL and C1, which include CSI U+009B) and the
// Unicode line and paragraph separators.
const CONTROL_CHARACTER = /[\p{Cc}\u{2028}\u{2029}]/u;

/** Display copies longer than this are truncated with a visible marker. */
export const DISPLAY_MAX_LENGTH = 120;

/** True when the value carries a character that could forge a line. */
export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER.test(value);
}

/** One physical line, every character the rule names visible, bounded in length. */
export function safeDisplay(value: unknown, maxLength: number = DISPLAY_MAX_LENGTH): string {
  const text = typeof value === 'string' ? value : String(value);
  const escaped = escapeOneLine(text);
  const cut = escapedCut(escaped, maxLength);
  if (cut === escaped.length) return escaped;
  return `${escaped.slice(0, cut)}…[+${escaped.length - cut} chars]`;
}
