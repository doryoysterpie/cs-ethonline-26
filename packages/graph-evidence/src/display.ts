/**
 * Safe single-line display of provider-controlled values.
 *
 * Every string that originates from a provider response (name, slug,
 * network, type, schema version, error messages, mismatch values) may
 * contain newlines, control characters or ANSI escape sequences that could
 * forge a target or gate line in the probe output. `safeDisplay` renders such
 * a value as one line with every control character shown as a visible escape
 * (`\n`, `\r`, `\t`, `\x1b`, `\xNN`, `\uNNNN`), so the formatter's own
 * intentional line breaks are the only line breaks in the output. The
 * underlying evidence is never mutated; only the display copy is transformed.
 */

const char = (code: number): string => String.fromCharCode(code);

/** ASCII escape, the introducer of ANSI sequences. */
export const ESCAPE_CHARACTER = char(0x1b);

// C0 controls (U+0000 to U+001F), DEL, C1 controls (U+0080 to U+009F, which
// include CSI U+009B), and the Unicode line and paragraph separators. Built
// from code points so that the source holds no control bytes.
const CONTROL_CHARACTERS = new RegExp(
  `[${char(0x00)}-${char(0x1f)}${char(0x7f)}-${char(0x9f)}${char(0x2028)}${char(0x2029)}]`,
  'g',
);

/** Display copies longer than this are truncated with a visible marker. */
export const DISPLAY_MAX_LENGTH = 200;

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

export function safeDisplay(value: unknown, maxLength: number = DISPLAY_MAX_LENGTH): string {
  const text = typeof value === 'string' ? value : String(value);
  const escaped = text.replace(CONTROL_CHARACTERS, escapeCharacter);
  if (escaped.length <= maxLength) return escaped;
  return `${escaped.slice(0, maxLength)}…[+${escaped.length - maxLength} chars]`;
}
