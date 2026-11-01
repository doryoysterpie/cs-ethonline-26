/**
 * The prohibited-text rule (D49): the one predicate for the code points that
 * no tracked file of this repository may carry, that no round-up export
 * keeps, and that no story card shows. Its three consumers hold no list of
 * their own: the hygiene check over tracked files (`tools/checks/hygiene.ts`,
 * which refuses), the round-up export (`@cas/roundup`, `text.ts`, which
 * strips), and the story card (`story-card.ts` here, which refuses, and the
 * dashboard's `cards/story.ts`, which strips).
 *
 * The invisible characters come from a Unicode property, not a list: every
 * code point the running Node reports as Default_Ignorable_Code_Point, the
 * property Unicode defines for characters that render as nothing, except
 * U+FE0E and U+FE0F, the two variation selectors emoji need. The bidirectional
 * controls are inside that property; they are named apart only so a finding
 * says which it is. The set follows the Unicode version of the running Node
 * (`process.versions.unicode`, recorded in the bill of materials), so a Node
 * upgrade is the event that changes it. The rest is fixed by Unicode itself:
 * the C0 and C1 controls other than tab, line feed and carriage return, the
 * line and paragraph separators, the interlinear annotation characters and
 * the noncharacters.
 *
 * This file holds none of the characters it names and imports nothing. The
 * hygiene check reads it as source, because that check runs before any build.
 */
export const PROHIBITED_TEXT_POLICY = 'prohibited-text@2';

/** The default-ignorable code points text may keep: the text and emoji presentation selectors. */
export const PERMITTED_DEFAULT_IGNORABLES: readonly number[] = [0xfe0e, 0xfe0f];

export const PROHIBITED_TEXT_RULES = [
  'c0_control',
  'c1_control',
  'line_separator',
  'bidi_control',
  'default_ignorable',
  'interlinear_annotation',
  'noncharacter',
] as const;
export type ProhibitedTextRule = (typeof PROHIBITED_TEXT_RULES)[number];

// The `v` flag's set difference keeps the class to one expression. It is built
// from a string because the compilation target predates the flag. The lint
// rule reads the two selectors as combining with the character before them;
// here they are set members on their own, the ones subtracted.
const PROHIBITED_CLASS =
  '[[\\p{Cc}\\p{Default_Ignorable_Code_Point}\\p{Noncharacter_Code_Point}\\u{2028}\\u{2029}\\u{FFF9}-\\u{FFFB}]--[\\t\\n\\r\\u{FE0E}\\u{FE0F}]]';
// eslint-disable-next-line no-misleading-character-class
const PROHIBITED_ONE = new RegExp(PROHIBITED_CLASS, 'v');
// eslint-disable-next-line no-misleading-character-class
const PROHIBITED_EVERY = new RegExp(PROHIBITED_CLASS, 'gv');
const BIDI_CONTROL = /\p{Bidi_Control}/u;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const NONCHARACTER = /\p{Noncharacter_Code_Point}/u;

/** The rule a code point breaks, or null when text may carry it. */
export function prohibitedTextRule(codePoint: number): ProhibitedTextRule | null {
  const character = String.fromCodePoint(codePoint);
  if (!PROHIBITED_ONE.test(character)) return null;
  if (codePoint <= 0x1f) return 'c0_control';
  if (codePoint >= 0x7f && codePoint <= 0x9f) return 'c1_control';
  if (codePoint === 0x2028 || codePoint === 0x2029) return 'line_separator';
  if (BIDI_CONTROL.test(character)) return 'bidi_control';
  if (DEFAULT_IGNORABLE.test(character)) return 'default_ignorable';
  if (NONCHARACTER.test(character)) return 'noncharacter';
  return 'interlinear_annotation';
}

/** True when the value carries a code point the rule prohibits. */
export function hasProhibitedText(value: string): boolean {
  return PROHIBITED_ONE.test(value);
}

/** The value with every code point the rule prohibits removed. */
export function removeProhibitedText(value: string): string {
  return value.replace(PROHIBITED_EVERY, '');
}

/** Every code point the rule prohibits, enumerated from the runtime, for the tests that hold each consumer to it. */
export function prohibitedCodePoints(): number[] {
  const out: number[] = [];
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    if (PROHIBITED_ONE.test(String.fromCodePoint(codePoint))) out.push(codePoint);
  }
  return out;
}
