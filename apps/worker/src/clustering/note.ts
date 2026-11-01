import { codePointLength, describeLocated, locateProhibitedText } from '@cas/contracts';

import { IngestionError } from '../editorial/errors.js';

/**
 * The one review-note policy (audit finding F4).
 *
 * Sprint 4 shipped this check in the command-line parser alone, so the
 * compiled `mergeIncidents` and `splitIncident` APIs persisted a note carrying
 * a newline and the database accepted it. A stored value that can forge a line
 * is a defect wherever it is stored, not only where it is typed, so the policy
 * now lives here and is applied by the worker APIs, by the command line and,
 * independently, by a CHECK constraint in migration 0007.
 *
 * The policy:
 *
 *   - **Length.** One to 280 characters. The bound counts code points, as the
 *     database's `length(note)` does, and it is the same 280 migration 0006 set.
 *     It is checked after the prohibited characters, so a refused character
 *     is named wherever it stands, even as the 280th.
 *   - **Absence.** `null` and `undefined` mean no note. An empty string is not
 *     a note and is refused rather than silently stored as absence, because
 *     absence and emptiness are distinguished in the canonical action payload
 *     and a caller that meant one must not get the other.
 *   - **Normalization.** None. The note is stored exactly as supplied. A
 *     normalizing transform would make the stored note differ from what the
 *     reviewer wrote and would move the payload digest in a way the caller
 *     cannot predict, so the note is validated and kept, never rewritten.
 *   - **Prohibited characters.** Every character the prohibited-text rule names
 *     (`@cas/contracts`, D49: the controls, the line and paragraph separators,
 *     the bidirectional controls and every other character that renders as
 *     nothing, but the two emoji presentation selectors), and tab, line feed and
 *     carriage return, since a note is one line (D50, point 2). The database's
 *     constraint (migration 0007) refuses the controls and separators; this
 *     refusal is the stricter one, made first.
 *
 * Neither message echoes the note or any part of its content. A character
 * refusal names the first refused character by its escape, name and position,
 * in the form the worker's source scanner reports in (`note:1:5:
 * default_ignorable \u{200B} ZERO WIDTH SPACE`), so the two read as one event.
 */

export const REVIEW_NOTE_MAX_LENGTH = 280;
export const REVIEW_NOTE_MIN_LENGTH = 1;

function invalid(message: string): IngestionError {
  return new IngestionError('configuration', 'note_invalid', message);
}

/**
 * Returns the note to store: `null` for an absent one, or the value unchanged.
 * Throws a fixed `note_invalid` configuration error otherwise.
 *
 * Called before the canonical payload is built, so a refused note never
 * reaches a hash, a digest, a database round trip or a printed line.
 */
export function assertReviewNote(
  note: string | null | undefined,
  where: string = 'note',
): string | null {
  if (note === undefined || note === null) return null;
  const tooLong = (): IngestionError =>
    invalid('a review note must be between 1 and 280 characters');
  // Code units first only to bound the walk: 280 code points are at most 560 code units.
  if (note.length > REVIEW_NOTE_MAX_LENGTH * 2) throw tooLong();
  const refused = locateProhibitedText(note, { oneLine: true })[0];
  if (refused !== undefined) {
    throw invalid(`a review note must not contain ${describeLocated(where, refused)}`);
  }
  const length = codePointLength(note);
  if (length < REVIEW_NOTE_MIN_LENGTH || length > REVIEW_NOTE_MAX_LENGTH) throw tooLong();
  return note;
}
