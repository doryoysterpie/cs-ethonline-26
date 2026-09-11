import type { Redactor } from './redact.js';

/**
 * Quoted evidence: how retrieved text leaves this server.
 *
 * Every string that originates outside the program, whether a headline stored
 * at import, a publisher category, a canonical URL or a provider-returned
 * protocol name, is evidence about the world and never an instruction. Before
 * any of it reaches a tool result it is rendered as a display copy:
 *
 *   - it is redacted first (Track D finding F3), so a secret is matched whole
 *     before any escape can alter it or any bound can split it;
 *   - C0 controls, DEL, C1 controls and the Unicode line and paragraph
 *     separators are shown as visible escapes (backslash-n, backslash-x1b,
 *     backslash-u2028), so a value cannot forge a line, a status field or a
 *     terminal sequence;
 *   - the two angle brackets are shown as backslash-u003c and backslash-u003e,
 *     so an HTML-like tag such as IMPORTANT or system in a headline cannot read
 *     as markup or as a directive to the consuming model (OWASP MCP guidance,
 *     section 12);
 *   - the copy is bounded with a visible truncation marker.
 *
 * The stored evidence is never mutated; only the copy that leaves is
 * transformed. The character classes are built from code points so this file
 * holds no control byte of its own.
 */

const char = (code: number): string => String.fromCharCode(code);

/** ASCII escape, the introducer of ANSI sequences. */
export const ESCAPE_CHARACTER = char(0x1b);

const CONTROL_CLASS = `[${char(0x00)}-${char(0x1f)}${char(0x7f)}-${char(0x9f)}${char(0x2028)}${char(0x2029)}]`;
const CONTROL_CHARACTERS = new RegExp(CONTROL_CLASS, 'g');
const CONTROL_CHARACTER = new RegExp(CONTROL_CLASS);
const ANGLE_BRACKETS = /[<>]/g;

// Directional formatting characters: the Arabic letter mark, the left-to-right
// and right-to-left marks, the embedding, override and pop controls, and the
// isolate controls. They reorder displayed text and are escaped at the error
// boundary (Track D finding F4).
const DIRECTIONAL_CLASS = `[${char(0x061c)}${char(0x200e)}${char(0x200f)}${char(0x202a)}-${char(0x202e)}${char(0x2066)}-${char(0x2069)}]`;
const DIRECTIONAL_CHARACTERS = new RegExp(DIRECTIONAL_CLASS, 'g');

/** Marker every quoted evidence value carries, so a consumer can tell it apart from server vocabulary. */
export const EVIDENCE_TRUST = 'untrusted_quoted_evidence' as const;

export interface QuotedEvidence {
  /** The display copy: redacted, single-line, escaped, bounded. */
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

/** True when the value carries any C0, DEL, C1 or Unicode line/paragraph separator character. */
export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER.test(value);
}

/** One physical line: every control character shown as a visible escape. Never truncates. */
export function toSingleLine(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.replace(CONTROL_CHARACTERS, escapeCharacter);
}

/** `toSingleLine`, then every directional formatting character shown as a visible escape. */
export function toSingleLineWithoutDirection(value: unknown): string {
  return toSingleLine(value).replace(DIRECTIONAL_CHARACTERS, escapeCharacter);
}

/** `toSingleLine`, then bounded to `maxLength` characters with a visible marker. */
export function safeDisplay(value: unknown, maxLength: number): string {
  const escaped = toSingleLine(value);
  if (escaped.length <= maxLength) return escaped;
  return `${escaped.slice(0, maxLength)}…[+${escaped.length - maxLength} chars]`;
}

/**
 * Renders one retrieved value as quoted evidence: redacted, then escaped, then
 * bounded, in that order. `null` stays `null`, so a missing value is
 * distinguishable from an empty one.
 */
export function quoteEvidence(
  value: string | null | undefined,
  maxLength: number,
  redact?: Redactor,
): QuotedEvidence | null {
  if (value === null || value === undefined) return null;
  const redacted = redact === undefined ? value : redact(value);
  const escaped = toSingleLine(redacted).replace(ANGLE_BRACKETS, escapeCharacter);
  const truncated = escaped.length > maxLength;
  return {
    text: truncated
      ? `${escaped.slice(0, maxLength)}…[+${escaped.length - maxLength} chars]`
      : escaped,
    truncated,
    trust: EVIDENCE_TRUST,
  };
}

/** A text column as the store fetched it: a bounded prefix and the stored value's true size. */
export interface BoundedTextField {
  readonly fragment: string;
  /** Characters (code points) of the whole stored value. */
  readonly characters: number;
}

function escapeForDisplay(character: string): string {
  return CONTROL_CHARACTER.test(character) || character === '<' || character === '>'
    ? escapeCharacter(character)
    : character;
}

/**
 * Renders a SQL-bounded column as quoted evidence, truthfully.
 *
 * The store fetches a prefix of the stored value (the display bound plus a
 * sentinel margin) together with the stored value's character count. In that
 * order:
 *
 *   1. the fragment is redacted, before anything is cut, so a secret that
 *      begins inside the displayed prefix is matched whole (the margin is
 *      sized for that) rather than split by the display cut;
 *   2. the display copy is built one code point at a time, each escaped as
 *      `quoteEvidence` escapes it, and stops before the first code point
 *      whose escape would not fit; an escape is never cut in half;
 *   3. `truncated` is true when the display copy omits anything the store
 *      holds: characters the fragment did not carry, or characters that did
 *      not fit; the marker counts both.
 *
 * The stored value is never touched; only the copy that leaves is bounded.
 */
export function quoteBoundedEvidence(
  field: BoundedTextField | null | undefined,
  maxLength: number,
  redact: (value: string) => string = (value) => value,
): QuotedEvidence | null {
  if (field === null || field === undefined) return null;
  const fetchedCharacters = [...field.fragment].length;
  const unfetched = Math.max(0, field.characters - fetchedCharacters);
  const points = [...redact(field.fragment)];
  let text = '';
  let shown = 0;
  for (const point of points) {
    const escaped = escapeForDisplay(point);
    if (text.length + escaped.length > maxLength) break;
    text += escaped;
    shown += 1;
  }
  const omitted = points.length - shown + unfetched;
  const truncated = omitted > 0;
  return {
    text: truncated ? `${text}…[+${omitted} chars]` : text,
    truncated,
    trust: EVIDENCE_TRUST,
  };
}
