import { describe, expect, it } from 'vitest';

import {
  NOTICE_CHARACTERS_MAX,
  isCleanedNotice,
  isErrorNotice,
  noticeCharacters,
  noticeCharactersParameter,
  NOTICE_AT_LENGTH_MAX,
  noticeField,
  noticeFor,
  noticeMore,
  noticeRevision,
} from './notices.ts';
import { NO_REFUSAL, removedAt, withNotice } from './page-support.ts';

describe('notices', () => {
  it('maps only fixed codes to fixed sentences', () => {
    expect(noticeFor('saved')).toBe('Saved.');
    expect(noticeFor('sign_in_failed')).toBe('Sign-in failed.');
    expect(noticeFor('<script>')).toBeNull();
    expect(noticeFor('SAVED')).toBeNull();
    expect(noticeFor(undefined)).toBeNull();
    expect(noticeFor('x'.repeat(40))).toBeNull();
    expect(isErrorNotice('forbidden')).toBe(true);
    expect(isErrorNotice('saved')).toBe(false);
  });

  it('carries characters as code points and positions only, and decodes nothing else (CAS-012, D50)', () => {
    const at = noticeCharactersParameter([
      { codePoint: 0xad, line: 4, column: 17 },
      { codePoint: 0x202e, line: 1, column: 2 },
    ]);
    expect(at).toBe('00AD-4-17,202E-1-2');
    expect(noticeCharacters(at)).toEqual([
      { codePoint: 0xad, line: 4, column: 17 },
      { codePoint: 0x202e, line: 1, column: 2 },
    ]);
    // A printable code point, text, a bad position or a malformed list decodes to nothing.
    for (const hostile of [
      '0041-1-1',
      'hello',
      '00AD-0-1',
      '00AD-1',
      '00ad-1-1',
      '110000-1-1',
      '00AD-1-1,',
      7,
    ]) {
      expect([hostile, noticeCharacters(hostile)]).toEqual([hostile, []]);
    }
    const many = Array.from({ length: 30 }, (_, i) => ({
      codePoint: 0x200b,
      line: 1,
      column: i + 1,
    }));
    expect(noticeCharacters(noticeCharactersParameter(many))).toHaveLength(NOTICE_CHARACTERS_MAX);
    expect(isErrorNotice('invalid_character')).toBe(true);
    expect(noticeFor('edited_cleaned')).toMatch(/removed before saving/u);
  });

  it('counts the refused characters a redirect leaves out, and names the revision of a cleaned save (review of db10902)', () => {
    const many = Array.from({ length: 27 }, (_, i) => ({
      codePoint: 0x202e,
      line: 1,
      column: i + 1,
    }));
    const refused = new URL(
      withNotice('/week/x?category=c', 'invalid_character', {
        field: 'markdown',
        characters: many,
      }),
      'http://h',
    );
    expect(noticeCharacters(refused.searchParams.get('at'))).toHaveLength(NOTICE_CHARACTERS_MAX);
    expect(noticeMore(refused.searchParams.get('more'))).toBe(7);
    expect(refused.searchParams.get('category')).toBe('c');
    const few = new URL(
      withNotice('/x', 'invalid_character', { field: null, characters: many.slice(0, 3) }),
      'http://h',
    );
    expect(few.searchParams.get('more')).toBeNull();
    const saved = new URL(withNotice('/x', 'saved_cleaned', NO_REFUSAL, 3), 'http://h');
    expect([
      saved.searchParams.get('at'),
      noticeRevision(saved.searchParams.get('revision')),
    ]).toEqual([null, 3]);
    for (const hostile of ['0', '-1', '1e3', 'x', '12345678', ' 3', undefined, 3]) {
      expect([hostile, noticeMore(hostile), noticeRevision(hostile)]).toEqual([hostile, 0, null]);
    }
    expect(isCleanedNotice('saved_cleaned') && isCleanedNotice('edited_cleaned')).toBe(true);
    expect(isCleanedNotice('saved')).toBe(false);
    const revisions = [
      { revision: 2, removedCharacters: [] },
      { revision: 3, removedCharacters: many },
    ];
    expect(removedAt(revisions, '3')).toHaveLength(27);
    expect(removedAt(revisions, '2')).toEqual([]);
    expect(removedAt(revisions, '9')).toEqual([]);
    expect(removedAt(revisions, 'three')).toEqual([]);
    expect(removedAt(revisions, undefined)).toEqual([]);
  });

  it('carries the first twenty in document order, the exact rest, the field, and nothing of the text (the D50 amendment)', () => {
    // Twenty entries of the longest form fit the bound computed from the cap.
    const longest = Array.from({ length: 25 }, (_, i) => ({
      // The two six-digit code points the rule names, U+10FFFE and U+10FFFF, both noncharacters.
      codePoint: i % 2 === 0 ? 0x10ffff : 0x10fffe,
      line: 9_999_999,
      column: 9_999_999 - i,
    }));
    const url = new URL(
      withNotice('/drafts/r', 'invalid_character', { field: 'markdown', characters: longest }),
      'http://h',
    );
    const at = url.searchParams.get('at') ?? '';
    expect(at.length).toBe(NOTICE_AT_LENGTH_MAX);
    expect(noticeCharacters(at)).toEqual(longest.slice(0, NOTICE_CHARACTERS_MAX));
    expect(noticeMore(url.searchParams.get('more'))).toBe(5);
    expect(noticeField(url.searchParams.get('field'))).toBe('markdown');
    expect(noticeCharacters(`${at},0041-1-1`)).toEqual([]);
    // The query string holds code points, positions, a field identifier and counts only.
    expect([...url.searchParams.keys()].sort()).toEqual(['at', 'field', 'more', 'notice']);
    for (const hostile of ['', 'Markdown', 'mark down', '<b>', 'x'.repeat(33), 7, undefined]) {
      expect([hostile, noticeField(hostile)]).toEqual([hostile, null]);
    }
    // No refused characters: no field travels.
    const plain = new URL(
      withNotice('/x', 'invalid', { field: 'title', characters: [] }),
      'http://h',
    );
    expect(plain.searchParams.get('field')).toBeNull();
  });
});
