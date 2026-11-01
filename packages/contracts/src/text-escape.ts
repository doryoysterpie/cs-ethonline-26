import {
  prohibitedTextRule,
  replaceProhibitedText,
  type ProhibitedTextRule,
} from './prohibited-text.js';
import { UNICODE_NAMES } from './unicode-names.js';

/**
 * One escape form for every character a reader has to see rather than meet
 * (D50, point 3), shared by the five displays, the refusals and the notices
 * that CAS-012 puts on the prohibited-text rule. A character is written
 * `\u{XXXX}`: uppercase hexadecimal, at least four digits, valid as written in
 * a TypeScript string and a `u`-flag expression at every code point, so an
 * escape copied from a report pastes into a test unchanged. Inside a displayed
 * value the escape is bare; a name follows it only on a line about the
 * character (a notice, a refusal, a log entry). Which characters are escaped
 * is the rule's alone: the names are labels and decide nothing.
 *
 * This file holds none of the characters it names.
 */
export const TEXT_ESCAPE_CONTRACT = 'text-escape@1';

/** `\u{XXXX}`, uppercase, at least four digits. */
export function escapeCodePoint(codePoint: number): string {
  return `\\u{${codePoint.toString(16).toUpperCase().padStart(4, '0')}}`;
}

/**
 * The character's Unicode name, or its control alias for a control, from the
 * generated table (`unicode-names.ts`), which holds the code points the rule
 * names and the three line characters; `null` for any other code point, and
 * for those of them with no name: unassigned code points, noncharacters, and
 * U+0080, U+0081 and U+0099.
 */
export function codePointName(codePoint: number): string | null {
  return UNICODE_NAMES.get(codePoint) ?? null;
}

/** The escape followed by the name when one is known: the form for a line about the character. */
export function describeCodePoint(codePoint: number): string {
  const name = codePointName(codePoint);
  return name === null ? escapeCodePoint(codePoint) : `${escapeCodePoint(codePoint)} ${name}`;
}

/**
 * A one-line value as a display shows it: every code point the rule names,
 * and tab, line feed and carriage return, written as a bare escape.
 */
export function escapeOneLine(value: string): string {
  return replaceProhibitedText(value, escapeCodePoint, { oneLine: true });
}

/** One stretch of a displayed value: text as it stands, or one escaped character. */
export interface EscapedPart {
  readonly text: string;
  readonly escape: boolean;
}

/**
 * `escapeOneLine` as parts, so a display can style each escape apart from the
 * text around it (D50, point 3): a literal backslash sequence in the value is
 * a text part, never taken for an escape.
 */
export function escapeOneLineParts(value: string): EscapedPart[] {
  const parts: EscapedPart[] = [];
  let plain = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const printable = codePoint >= 0x20 && codePoint < 0x7f;
    const escaped =
      !printable &&
      (codePoint === 0x09 ||
        codePoint === 0x0a ||
        codePoint === 0x0d ||
        prohibitedTextRule(codePoint) !== null);
    if (!escaped) {
      plain += character;
      continue;
    }
    if (plain.length > 0) parts.push({ text: plain, escape: false });
    plain = '';
    parts.push({ text: escapeCodePoint(codePoint), escape: true });
  }
  if (plain.length > 0) parts.push({ text: plain, escape: false });
  return parts;
}

/** A multi-line value as a display shows it: the rule's code points escaped, line breaks and tabs kept. */
export function escapeMultiLine(value: string): string {
  return replaceProhibitedText(value, escapeCodePoint);
}

/**
 * Where to cut an escaped value so that it is at most `max` long without
 * splitting an escape: an escape that would cross the limit is left out whole.
 */
export function escapedCut(escaped: string, max: number): number {
  if (escaped.length <= max) return escaped.length;
  const open = escaped.lastIndexOf('\\u{', max - 1);
  if (open >= 0 && escaped.indexOf('}', open) >= max) return open;
  return max;
}

/**
 * The length of a value in Unicode code points, the measure of every bound
 * that stands beside the rule: PostgreSQL's `length()` on a UTF-8 database
 * counts the same, and a column counts in it too. JavaScript's `length` counts
 * UTF-16 code units, two for each code point above U+FFFF.
 */
export function codePointLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    // A surrogate pair is one code point; a lone surrogate counts as one, as iteration counts it.
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    length += 1;
  }
  return length;
}

export interface LocatedCodePoint {
  readonly codePoint: number;
  /** The rule's label, or `line_character` for tab, line feed or carriage return in a one-line value. */
  readonly rule: ProhibitedTextRule | 'line_character';
  /** One-based. */
  readonly line: number;
  /** One-based, counted in code points. */
  readonly column: number;
}

/**
 * Every code point the rule names in a value, with its line and column, for a
 * notice or a refusal that names each character where it stands (D50, point
 * 1). With `oneLine`, tab, line feed and carriage return are reported too.
 */
export function locateProhibitedText(
  value: string,
  options: { readonly oneLine?: boolean } = {},
): LocatedCodePoint[] {
  const found: LocatedCodePoint[] = [];
  let line = 1;
  let column = 1;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const lineCharacter = codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d;
    const rule =
      options.oneLine === true && lineCharacter ? 'line_character' : prohibitedTextRule(codePoint);
    if (rule !== null) found.push({ codePoint, rule, line, column });
    if (codePoint === 0x0a) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return found;
}

/**
 * One line about one located character, the form every refusal and scan
 * reports in (D50): `where:line:column: rule \u{XXXX} NAME`. `where` is a
 * file path or a field name, never the value.
 */
export function describeLocated(where: string, located: LocatedCodePoint): string {
  return `${where}:${located.line}:${located.column}: ${located.rule} ${describeCodePoint(located.codePoint)}`;
}
