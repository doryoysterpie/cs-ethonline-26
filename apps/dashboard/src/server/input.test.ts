import { describe, expect, it } from 'vitest';

import { isDashboardError } from './errors.ts';
import {
  boundedText,
  enumOf,
  instant,
  integer,
  optionalInstant,
  optionalText,
  optionalUuid,
  readClosedObject,
  uuid,
  uuidList,
} from './input.ts';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (isDashboardError(error) && error.kind === 'validation') return error.code;
    throw error;
  }
  throw new Error('expected a validation failure');
};

const ID = '4f6a6e2e-1c2b-4a3d-8e5f-0123456789ab';

describe('closed objects', () => {
  it('reads exactly the declared keys from a plain object and a FormData', () => {
    expect(readClosedObject({ a: 1 }, ['a', 'b'])).toEqual({ a: 1, b: undefined });
    const form = new FormData();
    form.set('a', 'x');
    expect(readClosedObject(form, ['a', 'b'])).toEqual({ a: 'x', b: undefined });
    expect(readClosedObject(Object.create(null), ['a'])).toEqual({ a: undefined });
    // The framework's own action fields are skipped; a look-alike without the prefix is not.
    const action = new FormData();
    action.set('a', 'x');
    action.set('$ACTION_ID_0123abcd', '');
    action.set('$ACTION_REF_1', '');
    expect(readClosedObject(action, ['a'])).toEqual({ a: 'x' });
    const lookalike = new FormData();
    lookalike.set('a', 'x');
    lookalike.set('ACTION_ID_0123abcd', '');
    expect(() => readClosedObject(lookalike, ['a'])).toThrowError();
    const plain = { a: 1, $ACTION_ID_x: 2 };
    expect(() => readClosedObject(plain, ['a'])).toThrowError();
  });

  it('refuses unknown, repeated, symbol and accessor keys and foreign prototypes without echoing them', () => {
    expect(code(() => readClosedObject({ a: 1, secret: 2 }, ['a']))).toBe('unknown_field');
    const form = new FormData();
    form.append('a', '1');
    form.append('a', '2');
    expect(code(() => readClosedObject(form, ['a']))).toBe('repeated_field');
    const extra = new FormData();
    extra.set('__proto__', 'x');
    expect(code(() => readClosedObject(extra, ['a']))).toBe('unknown_field');
    expect(code(() => readClosedObject({ [Symbol('s')]: 1 }, ['a']))).toBe('symbol_key');
    const accessor = {};
    Object.defineProperty(accessor, 'a', { get: () => 1, enumerable: true });
    expect(code(() => readClosedObject(accessor, ['a']))).toBe('accessor_field');
    expect(code(() => readClosedObject(new Date(), ['a']))).toBe('foreign_prototype');
    expect(code(() => readClosedObject([], ['a']))).toBe('not_an_object');
    expect(code(() => readClosedObject(null, ['a']))).toBe('not_an_object');
    try {
      readClosedObject({ 'hostile<script>': 1 }, ['a']);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('hostile');
    }
  });
});

describe('field parsers', () => {
  it('uuid: lower-case canonical form only', () => {
    expect(uuid(ID, 'id')).toBe(ID);
    expect(code(() => uuid(ID.toUpperCase(), 'id'))).toBe('id_invalid');
    expect(code(() => uuid(`${ID} `, 'id'))).toBe('id_invalid');
    expect(code(() => uuid(42, 'id'))).toBe('id_invalid');
    expect(optionalUuid('', 'id')).toBeNull();
    expect(optionalUuid(undefined, 'id')).toBeNull();
  });

  it('enumOf: exact members only', () => {
    expect(enumOf('a', ['a', 'b'], 'x')).toBe('a');
    expect(code(() => enumOf('A', ['a', 'b'], 'x'))).toBe('x_invalid');
    expect(code(() => enumOf(['a'], ['a', 'b'], 'x'))).toBe('x_invalid');
  });

  it('boundedText: length in code units and no control characters', () => {
    expect(boundedText('fine', 'note', { min: 1, max: 4 })).toBe('fine');
    expect(code(() => boundedText('', 'note', { min: 1, max: 4 }))).toBe('note_length');
    expect(code(() => boundedText('toolong', 'note', { min: 1, max: 4 }))).toBe('note_length');
    expect(code(() => boundedText('a\nb', 'note', { min: 1, max: 4 }))).toBe('note_control');
    expect(
      code(() => boundedText(`a${String.fromCodePoint(0x2028)}b`, 'note', { min: 1, max: 4 })),
    ).toBe('note_control');
    expect(code(() => boundedText(1, 'note', { min: 1, max: 4 }))).toBe('note_invalid');
    expect(optionalText('', 'note', { min: 1, max: 4 })).toBeNull();
    expect(optionalText(null, 'note', { min: 1, max: 4 })).toBeNull();
  });

  it('integer: whole numbers in range from numbers or decimal strings', () => {
    expect(integer('7', 'n', { min: 0, max: 10 })).toBe(7);
    expect(integer(7, 'n', { min: 0, max: 10 })).toBe(7);
    expect(code(() => integer('7.5', 'n', { min: 0, max: 10 }))).toBe('n_invalid');
    expect(code(() => integer('11', 'n', { min: 0, max: 10 }))).toBe('n_invalid');
    expect(code(() => integer('0x7', 'n', { min: 0, max: 10 }))).toBe('n_invalid');
    expect(code(() => integer(Number.NaN, 'n', { min: 0, max: 10 }))).toBe('n_invalid');
  });

  it('instant: strict UTC RFC 3339, canonicalised', () => {
    expect(instant('2026-09-14T00:00Z', 't')).toBe('2026-09-14T00:00:00.000Z');
    expect(instant('2026-09-14T00:00:00.5Z', 't')).toBe('2026-09-14T00:00:00.500Z');
    expect(code(() => instant('2026-09-14', 't'))).toBe('t_invalid');
    expect(code(() => instant('2026-09-14T00:00:00+02:00', 't'))).toBe('t_invalid');
    expect(code(() => instant('2026-13-40T00:00:00Z', 't'))).toBe('t_invalid');
    expect(optionalInstant('', 't')).toBeNull();
  });

  it('uuidList: bounded, distinct, from an array or a comma-separated string', () => {
    const other = ID.replace('4f6a', '4f6b');
    expect(uuidList(`${ID}, ${other}`, 'ids', 2)).toEqual([ID, other]);
    expect(uuidList([ID], 'ids', 2)).toEqual([ID]);
    expect(code(() => uuidList(`${ID},${ID}`, 'ids', 5))).toBe('ids_repeated');
    expect(code(() => uuidList(`${ID},${other}`, 'ids', 1))).toBe('ids_too_many');
    expect(code(() => uuidList('', 'ids', 1))).toBe('ids_empty');
    expect(code(() => uuidList(`${ID},nope`, 'ids', 5))).toBe('ids_invalid');
  });
});
