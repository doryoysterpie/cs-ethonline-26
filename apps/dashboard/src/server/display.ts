/**
 * Safe display of hostile stored text.
 *
 * React escapes markup, so a stored `<script>` renders as text. What React
 * does not do is make an invisible character visible: a C0 or C1 control, a
 * Unicode line separator, or a bidirectional override that reverses the
 * reading order of everything after it. `safeText` renders each of those as
 * a visible escape and bounds the length with a visible marker, so a hostile
 * title can neither hide content nor re-order a line in the reader's eye.
 *
 * The character classes are built from code points so this source file holds
 * none of them. This module is pure and is shared by server components and
 * unit tests; it imports nothing.
 */

const char = (code: number): string => String.fromCodePoint(code);

/**
 * C0 controls, DEL, C1 controls, the Unicode line and paragraph separators,
 * and the bidirectional embedding, override and isolate controls
 * (U+202A to U+202E, U+2066 to U+2069).
 */
const ESCAPED_CLASS = `[${char(0x00)}-${char(0x1f)}${char(0x7f)}-${char(0x9f)}${char(0x2028)}${char(0x2029)}${char(0x202a)}-${char(0x202e)}${char(0x2066)}-${char(0x2069)}]`;
const ESCAPED_CHARACTERS = new RegExp(ESCAPED_CLASS, 'gu');
const ESCAPED_CHARACTER = new RegExp(ESCAPED_CLASS, 'u');

/** Display copies longer than this are truncated with a visible marker. */
export const DISPLAY_MAX_LENGTH = 300;

function escapeCharacter(character: string): string {
  const code = character.codePointAt(0) ?? 0;
  if (code === 0x0a) return '\\n';
  if (code === 0x0d) return '\\r';
  if (code === 0x09) return '\\t';
  if (code === 0x1b) return '\\x1b';
  return code > 0xff
    ? `\\u${code.toString(16).padStart(4, '0')}`
    : `\\x${code.toString(16).padStart(2, '0')}`;
}

/** True when the value carries a character `safeText` would escape. */
export function hasEscapedCharacter(value: string): boolean {
  return ESCAPED_CHARACTER.test(value);
}

/** Every escaped-class character shown as a visible escape; never truncated. */
export function visibleControls(value: string): string {
  return value.replace(ESCAPED_CHARACTERS, escapeCharacter);
}

/** `visibleControls`, then bounded to `maxLength` characters with a visible marker. */
export function safeText(value: unknown, maxLength: number = DISPLAY_MAX_LENGTH): string {
  const text = typeof value === 'string' ? value : value === null ? '' : String(value);
  const escaped = visibleControls(text);
  if (escaped.length <= maxLength) return escaped;
  return `${escaped.slice(0, maxLength)}…[+${escaped.length - maxLength} chars]`;
}
