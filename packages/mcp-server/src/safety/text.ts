/**
 * Quoted evidence: how retrieved text leaves this server.
 *
 * Every string that originates outside the program, whether a headline stored
 * at import, a publisher category, a canonical URL or a provider-returned
 * protocol name, is evidence about the world and never an instruction. Before
 * any of it reaches a tool result it is rendered as a display copy:
 *
 *   - C0 controls, DEL, C1 controls and the Unicode line and paragraph
 *     separators are shown as visible escapes (backslash-n, backslash-x1b,
 *     backslash-u2028), so a value cannot forge a line, a status field or a
 *     terminal sequence;
 *   - the bidirectional controls (U+061C, U+200E, U+200F, U+202A to U+202E,
 *     U+2066 to U+2069) and the invisible formatting characters (U+200B,
 *     U+2060 to U+2064, U+FEFF) are shown as visible escapes too, so a value
 *     cannot reverse, hide or reorder what a reader sees (the Trojan Source
 *     class of attack). Joiners used by ordinary text, U+200C and U+200D, are
 *     left alone;
 *   - the two angle brackets are shown as backslash-u003c and backslash-u003e,
 *     so an HTML-like tag such as IMPORTANT or system in a headline cannot read
 *     as markup or as a directive to the consuming model (OWASP MCP guidance,
 *     section 12);
 *   - the copy is bounded with a visible truncation marker.
 *
 * The stored evidence is never mutated; only the copy that leaves is
 * transformed. The character class is built from code points so this file
 * holds no control byte of its own. A display copy that is placed inside
 * Markdown is escaped once more by `markdown.ts`.
 */

const char = (code: number): string => String.fromCharCode(code);

/** ASCII escape, the introducer of ANSI sequences. */
export const ESCAPE_CHARACTER = char(0x1b);

const CONTROL_CLASS = `[${char(0x00)}-${char(0x1f)}${char(0x7f)}-${char(0x9f)}${char(0x2028)}${char(0x2029)}${char(0x061c)}${char(0x200b)}${char(0x200e)}${char(0x200f)}${char(0x202a)}-${char(0x202e)}${char(0x2060)}-${char(0x2064)}${char(0x2066)}-${char(0x2069)}${char(0xfeff)}]`;
const CONTROL_CHARACTERS = new RegExp(CONTROL_CLASS, 'g');
const CONTROL_CHARACTER = new RegExp(CONTROL_CLASS);
const ANGLE_BRACKETS = /[<>]/g;

/** Marker every quoted evidence value carries, so a consumer can tell it apart from server vocabulary. */
export const EVIDENCE_TRUST = 'untrusted_quoted_evidence' as const;

export interface QuotedEvidence {
  /** The display copy: single-line, escaped, bounded. */
  readonly text: string;
  /** True when the display copy was cut at the bound. */
  readonly truncated: boolean;
  readonly trust: typeof EVIDENCE_TRUST;
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
    case '<':
      return '\\u003c';
    case '>':
      return '\\u003e';
    default: {
      const code = character.codePointAt(0) ?? 0;
      return code > 0xff
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : `\\x${code.toString(16).padStart(2, '0')}`;
    }
  }
}

/**
 * True when the value carries any C0, DEL, C1, Unicode line/paragraph
 * separator, bidirectional control or invisible formatting character.
 */
export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER.test(value);
}

/** One physical line: every control character shown as a visible escape. Never truncates. */
export function toSingleLine(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.replace(CONTROL_CHARACTERS, escapeCharacter);
}

/** `toSingleLine`, then bounded to `maxLength` characters with a visible marker. */
export function safeDisplay(value: unknown, maxLength: number): string {
  const escaped = toSingleLine(value);
  if (escaped.length <= maxLength) return escaped;
  return `${escaped.slice(0, maxLength)}…[+${escaped.length - maxLength} chars]`;
}

/**
 * Renders one retrieved value as quoted evidence. `null` stays `null`, so a
 * missing value is distinguishable from an empty one.
 */
export function quoteEvidence(
  value: string | null | undefined,
  maxLength: number,
): QuotedEvidence | null {
  if (value === null || value === undefined) return null;
  const escaped = toSingleLine(value).replace(ANGLE_BRACKETS, escapeCharacter);
  const truncated = escaped.length > maxLength;
  return {
    text: truncated
      ? `${escaped.slice(0, maxLength)}…[+${escaped.length - maxLength} chars]`
      : escaped,
    truncated,
    trust: EVIDENCE_TRUST,
  };
}
