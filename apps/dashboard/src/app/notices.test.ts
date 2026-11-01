import { describe, expect, it } from 'vitest';

import {
  NOTICE_CHARACTERS_MAX,
  isErrorNotice,
  noticeCharacters,
  noticeCharactersParameter,
  noticeFor,
} from './notices.ts';

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
});
