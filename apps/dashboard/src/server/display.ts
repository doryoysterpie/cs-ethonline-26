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

/** The editorial clock (D10): one zone, always shown with its offset so the instant is unambiguous. */
export const EDITORIAL_TIME_ZONE = 'America/Toronto';

/**
 * An instant for the shell's "as of" line (CAS-010, decision 1): the
 * calendar date and minute in the editorial zone, the zone's name and its
 * UTC offset at that instant, so a reader anywhere can place it. Null, or an
 * instant that does not parse, renders as a dash: nothing is invented.
 */
export function formatAsOf(instant: string | null): string {
  if (instant === null) return '—';
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EDITORIAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(at));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const offset = part('timeZoneName').replace(/^GMT/u, 'UTC').replace(/^UTC$/u, 'UTC+00:00');
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} ${EDITORIAL_TIME_ZONE} (${offset})`;
}
