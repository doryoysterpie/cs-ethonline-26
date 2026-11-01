import { DatabaseError } from './errors.js';

/**
 * One character a save removed from the text submitted for a revision
 * (CAS-012, D50, point 1; migration 0024): its code point, and its line and
 * column in that text, counted in code points from 1. Numbers only: the
 * record never holds the character.
 */
export interface RemovedCharacter {
  readonly codePoint: number;
  readonly line: number;
  readonly column: number;
}

/** The stored form, `[code point, line, column]` per entry, as migration 0024's check reads it. */
export function removedCharactersJson(removed: readonly RemovedCharacter[] = []): string {
  return JSON.stringify(removed.map(({ codePoint, line, column }) => [codePoint, line, column]));
}

const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

/**
 * The stored record read back. The column's check admits nothing else, so an
 * entry of another shape is a defect in the stored data and fails the read
 * rather than being shown or skipped.
 */
export function removedCharactersFrom(value: unknown): RemovedCharacter[] {
  if (!Array.isArray(value)) throw new DatabaseError('query', 'removed characters not a list');
  return value.map((entry: unknown) => {
    if (!Array.isArray(entry) || entry.length !== 3 || !entry.every(whole)) {
      throw new DatabaseError('query', 'removed character entry malformed');
    }
    const [codePoint, line, column] = entry as [number, number, number];
    if (codePoint > 0x10ffff) throw new DatabaseError('query', 'removed character entry malformed');
    return { codePoint, line, column };
  });
}
