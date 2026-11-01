import { escapeOneLine, escapedCut } from '@cas/contracts';

/**
 * Safe single-line display of provider-controlled values.
 *
 * Every string that originates from a provider response (name, slug,
 * network, type, schema version, error messages, mismatch values) may
 * contain newlines, control characters or ANSI escape sequences that could
 * forge a target or gate line in the probe output. `safeDisplay` renders such
 * a value as one line with every character the prohibited-text rule names, and
 * tab, line feed and carriage return, shown as a visible escape in the one form
 * (`\u{001B}`, D50; `@cas/contracts`), so the formatter's own intentional line
 * breaks are the only line breaks in the output. The underlying evidence is
 * never mutated; only the display copy is transformed.
 */

const char = (code: number): string => String.fromCharCode(code);

/** ASCII escape, the introducer of ANSI sequences. */
export const ESCAPE_CHARACTER = char(0x1b);

/** Display copies longer than this are truncated with a visible marker. */
export const DISPLAY_MAX_LENGTH = 200;

export function safeDisplay(value: unknown, maxLength: number = DISPLAY_MAX_LENGTH): string {
  const text = typeof value === 'string' ? value : String(value);
  const escaped = escapeOneLine(text);
  const cut = escapedCut(escaped, maxLength);
  if (cut === escaped.length) return escaped;
  return `${escaped.slice(0, cut)}…[+${escaped.length - cut} chars]`;
}
