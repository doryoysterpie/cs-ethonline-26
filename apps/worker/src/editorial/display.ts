import { escapeOneLine, escapedCut } from '@cas/contracts';

/**
 * Safe single-line display of untrusted metadata: file basenames, review
 * labels and any other value that reaches a printed line from outside the
 * program. A filename or label can carry newlines, carriage returns, tabs,
 * ANSI escape sequences, C0 or C1 controls, or the Unicode line and paragraph
 * separators, any of which could forge a status, batch, reconciliation or
 * issue line in terminal output or captured evidence.
 *
 * `toSingleLine` renders every character the prohibited-text rule names, and
 * tab, line feed and carriage return, as a visible escape in the one form
 * (`\u{001B}`, D50) without truncation, so the formatter's own line breaks are
 * the only line breaks that exist. `safeDisplay` additionally bounds the
 * length with a visible marker, never splitting an escape.
 * Callers redact secrets BEFORE escaping, so a secret that itself contains a
 * control character still matches the redactor.
 *
 * The set and the form are `@cas/contracts`' (CAS-012); `hasControlCharacter`
 * keeps the controls and separators the database's constraints refuse.
 */

const char = (code: number): string => String.fromCharCode(code);

/** ASCII escape, the introducer of ANSI sequences. */
export const ESCAPE_CHARACTER = char(0x1b);

// The controls (`\p{Cc}`: C0, DEL and C1, which include CSI U+009B) and the
// Unicode line and paragraph separators, as the database's constraints refuse them.
const CONTROL_CHARACTER = /[\p{Cc}\u{2028}\u{2029}]/u;

/** Display copies of metadata longer than this are truncated with a visible marker. */
export const DISPLAY_MAX_LENGTH = 200;
/** Fixed maximum for a review label, after trimming. */
export const MAX_REVIEW_LABEL_LENGTH = 64;
/** Fixed maximum for a stored source basename. */
export const MAX_BASENAME_LENGTH = 255;

/** True when the value carries any C0, DEL, C1 or Unicode line/paragraph separator character. */
export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER.test(value);
}

/** One physical line: every character the rule names, and the three line characters, escaped. Never truncates. */
export function toSingleLine(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return escapeOneLine(text);
}

/** `toSingleLine`, then bounded to `maxLength` characters with a visible marker. */
export function safeDisplay(value: unknown, maxLength: number = DISPLAY_MAX_LENGTH): string {
  const escaped = toSingleLine(value);
  const cut = escapedCut(escaped, maxLength);
  if (cut === escaped.length) return escaped;
  return `${escaped.slice(0, cut)}…[+${escaped.length - cut} chars]`;
}
