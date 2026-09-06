/**
 * Safe single-line display of untrusted metadata: file basenames, review
 * labels and any other value that reaches a printed line from outside the
 * program. A filename or label can carry newlines, carriage returns, tabs,
 * ANSI escape sequences, C0 or C1 controls, or the Unicode line and paragraph
 * separators, any of which could forge a status, batch, reconciliation or
 * issue line in terminal output or captured evidence.
 *
 * `toSingleLine` renders every such character as a visible escape (`\n`,
 * `\r`, `\t`, `\x1b`, `\xNN`, `\uNNNN`) without truncation, so the
 * formatter's own line breaks are the only line breaks that exist.
 * `safeDisplay` additionally bounds the length with a visible marker.
 * Callers redact secrets BEFORE escaping, so a secret that itself contains a
 * control character still matches the redactor.
 *
 * Mirrors the proven approach in `@cas/graph-evidence` without depending on
 * it. The expression is built from code points so the source holds no control
 * byte.
 */

const char = (code: number): string => String.fromCharCode(code);

/** ASCII escape, the introducer of ANSI sequences. */
export const ESCAPE_CHARACTER = char(0x1b);

// C0 controls (U+0000 to U+001F), DEL, C1 controls (U+0080 to U+009F, which
// include CSI U+009B), and the Unicode line and paragraph separators.
const CONTROL_CLASS = `[${char(0x00)}-${char(0x1f)}${char(0x7f)}-${char(0x9f)}${char(0x2028)}${char(0x2029)}]`;
const CONTROL_CHARACTERS = new RegExp(CONTROL_CLASS, 'g');
const CONTROL_CHARACTER = new RegExp(CONTROL_CLASS);

/** Display copies of metadata longer than this are truncated with a visible marker. */
export const DISPLAY_MAX_LENGTH = 200;
/** Fixed maximum for a review label, after trimming. */
export const MAX_REVIEW_LABEL_LENGTH = 64;
/** Fixed maximum for a stored source basename. */
export const MAX_BASENAME_LENGTH = 255;

function escapeCharacter(character: string): string {
  switch (character) {
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    case ESCAPE_CHARACTER:
      return '\\x1b';
    default: {
      const code = character.codePointAt(0) ?? 0;
      return code > 0xff
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : `\\x${code.toString(16).padStart(2, '0')}`;
    }
  }
}

/** True when the value carries any C0, DEL, C1 or Unicode line/paragraph separator character. */
export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER.test(value);
}

/** One physical line: every control character shown as a visible escape. Never truncates. */
export function toSingleLine(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.replace(CONTROL_CHARACTERS, escapeCharacter);
}

/** `toSingleLine`, then bounded to `maxLength` characters with a visible marker. */
export function safeDisplay(value: unknown, maxLength: number = DISPLAY_MAX_LENGTH): string {
  const escaped = toSingleLine(value);
  if (escaped.length <= maxLength) return escaped;
  return `${escaped.slice(0, maxLength)}…[+${escaped.length - maxLength} chars]`;
}
