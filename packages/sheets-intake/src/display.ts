/**
 * Safe single-line display of workbook-controlled values.
 *
 * A tab name, a header cell and an API error message are all authored by
 * someone other than this program. Any of them may carry newlines, carriage
 * returns, ANSI escape introducers or Unicode line separators, and any of
 * those could forge a line in a report that a human reads as this program's
 * own output. `safeDisplay` renders such a value as exactly one line, with
 * every control character shown as a visible escape, so the formatter's own
 * line breaks are the only line breaks in the output.
 *
 * The underlying value is never mutated; only the display copy is transformed.
 * This mirrors the identical guard in `@cas/graph-evidence` and the worker's
 * editorial display, because the hazard is the same one.
 */

const char = (code: number): string => String.fromCharCode(code);

/** ASCII escape, the introducer of ANSI sequences. */
export const ESCAPE_CHARACTER = char(0x1b);

// C0 controls (U+0000 to U+001F), DEL, C1 controls (U+0080 to U+009F, which
// include CSI U+009B), and the Unicode line and paragraph separators. Built
// from code points so that this source file holds no control bytes.
const CONTROL_CLASS = `[${char(0x00)}-${char(0x1f)}${char(0x7f)}-${char(0x9f)}${char(0x2028)}${char(0x2029)}]`;
const CONTROL_CHARACTERS = new RegExp(CONTROL_CLASS, 'g');
const CONTROL_CHARACTER = new RegExp(CONTROL_CLASS);

/** Display copies longer than this are truncated with a visible marker. */
export const DISPLAY_MAX_LENGTH = 120;

/** True when the value carries a character that could forge a line. */
export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER.test(value);
}

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

/** One physical line, every control character visible, bounded in length. */
export function safeDisplay(value: unknown, maxLength: number = DISPLAY_MAX_LENGTH): string {
  const text = typeof value === 'string' ? value : String(value);
  const escaped = text.replace(CONTROL_CHARACTERS, escapeCharacter);
  if (escaped.length <= maxLength) return escaped;
  return `${escaped.slice(0, maxLength)}…[+${escaped.length - maxLength} chars]`;
}
