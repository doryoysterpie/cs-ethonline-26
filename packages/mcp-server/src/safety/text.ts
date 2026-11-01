import { escapeCodePoint, escapeOneLine, escapedCut, hasProhibitedText } from '@cas/contracts';

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
 *   - every character the prohibited-text rule names (`@cas/contracts`, D49:
 *     the controls, the line and paragraph separators, the bidirectional
 *     controls, every other default-ignorable character but the two emoji
 *     presentation selectors, the interlinear annotation characters and the
 *     noncharacters), and tab, line feed and carriage return, is shown as a
 *     visible escape in the one form, `\u{202E}` (D50), so a value cannot
 *     forge a line, a status field or a terminal sequence, nor reverse, hide
 *     or reorder what a reader sees (the Trojan Source class of attack);
 *   - the two angle brackets are shown as `\u{003C}` and `\u{003E}`,
 *     so an HTML-like tag such as IMPORTANT or system in a headline cannot read
 *     as markup or as a directive to the consuming model (OWASP MCP guidance,
 *     section 12);
 *   - the copy is bounded with a visible truncation marker.
 *
 * The stored evidence is never mutated; only the copy that leaves is
 * transformed. The set and the form are `@cas/contracts`' (CAS-012). A display
 * copy that is placed inside Markdown is escaped once more by `markdown.ts`.
 */

const char = (code: number): string => String.fromCharCode(code);

/** ASCII escape, the introducer of ANSI sequences. */
export const ESCAPE_CHARACTER = char(0x1b);

const LINE_CHARACTER = /[\t\n\r]/u;
const ANGLE_BRACKETS = /[<>]/gu;

/** Marker every quoted evidence value carries, so a consumer can tell it apart from server vocabulary. */
export const EVIDENCE_TRUST = 'untrusted_quoted_evidence' as const;

export interface QuotedEvidence {
  /** The display copy: redacted, single-line, escaped, bounded. */
  readonly text: string;
  /** True when the display copy was cut at the bound. */
  readonly truncated: boolean;
  readonly trust: typeof EVIDENCE_TRUST;
}

function escapeAngle(character: string): string {
  return escapeCodePoint(character.codePointAt(0) ?? 0);
}

/**
 * True when the value carries a character the prohibited-text rule names, or
 * tab, line feed or carriage return: the arguments the boundary refuses.
 */
export function hasControlCharacter(value: string): boolean {
  return LINE_CHARACTER.test(value) || hasProhibitedText(value);
}

/** One physical line: every character the rule names, and the three line characters, escaped. Never truncates. */
export function toSingleLine(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return escapeOneLine(text);
}

/**
 * `toSingleLine`, kept for the error boundary (Track D finding F4): the
 * directional formatting characters are among those the rule names, so they
 * are escaped with the rest.
 */
export function toSingleLineWithoutDirection(value: unknown): string {
  return toSingleLine(value);
}

/** `toSingleLine`, then bounded to `maxLength` characters with a visible marker, never splitting an escape. */
export function safeDisplay(value: unknown, maxLength: number): string {
  const escaped = toSingleLine(value);
  const cut = escapedCut(escaped, maxLength);
  if (cut === escaped.length) return escaped;
  return `${escaped.slice(0, cut)}…[+${escaped.length - cut} chars]`;
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
  const escaped = toSingleLine(redacted).replace(ANGLE_BRACKETS, escapeAngle);
  const cut = escapedCut(escaped, maxLength);
  const truncated = cut < escaped.length;
  return {
    text: truncated ? `${escaped.slice(0, cut)}…[+${escaped.length - cut} chars]` : escaped,
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
  if (character === '<' || character === '>') return escapeAngle(character);
  return escapeOneLine(character);
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
