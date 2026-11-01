import {
  prohibitedTextRule,
  replaceProhibitedText,
  type ProhibitedTextRule,
} from './prohibited-text.js';

/**
 * One escape form for every character a reader has to see rather than meet
 * (D50, point 3), shared by the five displays, the refusals and the notices
 * that CAS-012 puts on the prohibited-text rule. A character is written
 * `\u{XXXX}`: uppercase hexadecimal, at least four digits, valid as written in
 * a TypeScript string and a `u`-flag expression at every code point, so an
 * escape copied from a report pastes into a test unchanged. Inside a displayed
 * value the escape is bare; a name follows it only on a line about the
 * character (a notice, a refusal, a log entry). Which characters are escaped
 * is the rule's alone: the names below are labels and decide nothing.
 *
 * This file holds none of the characters it names.
 */
export const TEXT_ESCAPE_CONTRACT = 'text-escape@1';

/** `\u{XXXX}`, uppercase, at least four digits. */
export function escapeCodePoint(codePoint: number): string {
  return `\\u{${codePoint.toString(16).toUpperCase().padStart(4, '0')}}`;
}

const NAMES: ReadonlyMap<number, string> = new Map([
  [0x0000, 'NULL'],
  [0x0009, 'CHARACTER TABULATION'],
  [0x000a, 'LINE FEED'],
  [0x000d, 'CARRIAGE RETURN'],
  [0x001b, 'ESCAPE'],
  [0x007f, 'DELETE'],
  [0x00ad, 'SOFT HYPHEN'],
  [0x034f, 'COMBINING GRAPHEME JOINER'],
  [0x061c, 'ARABIC LETTER MARK'],
  [0x115f, 'HANGUL CHOSEONG FILLER'],
  [0x1160, 'HANGUL JUNGSEONG FILLER'],
  [0x17b4, 'KHMER VOWEL INHERENT AQ'],
  [0x17b5, 'KHMER VOWEL INHERENT AA'],
  [0x180b, 'MONGOLIAN FREE VARIATION SELECTOR ONE'],
  [0x180c, 'MONGOLIAN FREE VARIATION SELECTOR TWO'],
  [0x180d, 'MONGOLIAN FREE VARIATION SELECTOR THREE'],
  [0x180e, 'MONGOLIAN VOWEL SEPARATOR'],
  [0x180f, 'MONGOLIAN FREE VARIATION SELECTOR FOUR'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x2028, 'LINE SEPARATOR'],
  [0x2029, 'PARAGRAPH SEPARATOR'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2060, 'WORD JOINER'],
  [0x2061, 'FUNCTION APPLICATION'],
  [0x2062, 'INVISIBLE TIMES'],
  [0x2063, 'INVISIBLE SEPARATOR'],
  [0x2064, 'INVISIBLE PLUS'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0x3164, 'HANGUL FILLER'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE'],
  [0xffa0, 'HALFWIDTH HANGUL FILLER'],
  [0xfff9, 'INTERLINEAR ANNOTATION ANCHOR'],
  [0xfffa, 'INTERLINEAR ANNOTATION SEPARATOR'],
  [0xfffb, 'INTERLINEAR ANNOTATION TERMINATOR'],
  [0xe0001, 'LANGUAGE TAG'],
  [0xe007f, 'CANCEL TAG'],
]);

/** The character's Unicode name, or its name alias for a control, when this table or a range knows it. */
export function codePointName(codePoint: number): string | null {
  const named = NAMES.get(codePoint);
  if (named !== undefined) return named;
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) {
    return `VARIATION SELECTOR-${codePoint - 0xfe00 + 1}`;
  }
  if (codePoint >= 0xe0100 && codePoint <= 0xe01ef) {
    return `VARIATION SELECTOR-${codePoint - 0xe0100 + 17}`;
  }
  return null;
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

export interface LocatedCodePoint {
  readonly codePoint: number;
  readonly rule: ProhibitedTextRule;
  /** One-based. */
  readonly line: number;
  /** One-based, counted in code points. */
  readonly column: number;
}

/**
 * Every code point the rule names in a value, with its line and column, for a
 * notice or a refusal that names each character where it stands (D50, point 1).
 */
export function locateProhibitedText(value: string): LocatedCodePoint[] {
  const found: LocatedCodePoint[] = [];
  let line = 1;
  let column = 1;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const rule = prohibitedTextRule(codePoint);
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
