import 'server-only';

import {
  codePointLength,
  locateProhibitedText,
  removeProhibitedText,
  type LocatedCodePoint,
} from '@cas/contracts';

import { characterRefusal, validation } from '../errors.ts';

/** A body as a save keeps it, and every character removed from what was submitted. */
export interface CleanedBody {
  readonly body: string;
  readonly removed: readonly LocatedCodePoint[];
}

/**
 * A draft, round-up or article body as a save keeps it (D50, point 1). A
 * control other than tab, line feed and carriage return (`\p{Cc}`), or a
 * bidirectional control (`\p{Bidi_Control}`), refuses the save: in English
 * text it means a hostile source or a broken paste, and the owner sees each
 * one named where it stands. Every other character the prohibited-text rule
 * names (a soft hyphen, a zero-width space, a byte-order mark from a copied
 * page) is removed before the revision is computed, so no stored revision
 * holds one, and each removal is returned, with its line and column in the
 * text as submitted, for the notice. Re-saving the cleaned text removes
 * nothing.
 *
 * The bound applies to the body as stored, after the strip, and counts code
 * points, as PostgreSQL's `length()` does. The code-unit check first only
 * keeps the walk bounded: a stored body of `max` code points is at most twice
 * `max` code units, and the check leaves as much again for what the strip
 * removes, so a submission over four times `max` code units is refused as too
 * long before any character is examined.
 */
export function cleanedBody(markdown: string, label: string, max: number): CleanedBody {
  const tooLong = () =>
    validation('markdown_length', `The ${label} body must be between 1 and ${max} characters.`);
  if (markdown.length > max * 4) throw tooLong();
  const located = locateProhibitedText(markdown);
  const refused = located.filter(
    (character) =>
      character.rule === 'c0_control' ||
      character.rule === 'c1_control' ||
      character.rule === 'bidi_control',
  );
  if (refused.length > 0) throw characterRefusal('markdown_control', 'markdown', refused);
  const body = located.length === 0 ? markdown : removeProhibitedText(markdown);
  const length = codePointLength(body);
  if (length < 1 && located.length > 0) {
    throw validation(
      'markdown_length',
      `The ${label} body holds nothing once its invisible characters are removed.`,
    );
  }
  if (length < 1 || length > max) throw tooLong();
  return { body, removed: located };
}
