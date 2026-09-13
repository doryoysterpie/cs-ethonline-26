import { hasControlCharacter } from '../editorial/display.js';
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
 *   - **Length.** One to 280 characters. The bound is characters, matching the
 *     database's `length(note)`, and it is the same 280 migration 0006 set.
 *   - **Absence.** `null` and `undefined` mean no note. An empty string is not
 *     a note and is refused rather than silently stored as absence, because
 *     absence and emptiness are distinguished in the canonical action payload
 *     and a caller that meant one must not get the other.
 *   - **Normalization.** None. The note is stored exactly as supplied. A
 *     normalizing transform would make the stored note differ from what the
 *     reviewer wrote and would move the payload digest in a way the caller
 *     cannot predict, so the note is validated and kept, never rewritten.
 *   - **Prohibited characters.** Every C0 control (U+0000 to U+001F, which
 *     covers NUL, newline, carriage return, tab and the ANSI escape introducer
 *     U+001B), DEL (U+007F), every C1 control (U+0080 to U+009F, which covers
 *     the eight-bit CSI U+009B), and the Unicode line and paragraph separators
 *     U+2028 and U+2029. This is exactly the class `hasControlCharacter`
 *     already refuses for a filename or a review label, and exactly the class
 *     migration 0007 refuses in the database.
 *
 * Both messages are fixed and neither echoes the note, its length or any part
 * of its content.
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
export function assertReviewNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null;
  if (note.length < REVIEW_NOTE_MIN_LENGTH || note.length > REVIEW_NOTE_MAX_LENGTH) {
    throw invalid('a review note must be between 1 and 280 characters');
  }
  if (hasControlCharacter(note)) {
    throw invalid('a review note must not contain a control character');
  }
  return note;
}
