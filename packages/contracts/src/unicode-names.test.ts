import { describe, expect, it } from 'vitest';

import { prohibitedCodePoints } from './prohibited-text.js';
import { codePointName, describeCodePoint } from './text-escape.js';
import { UNICODE_NAMES } from './unicode-names.js';

const ASSIGNED = /^\p{Assigned}$/u;
const LINE_CHARACTERS = [0x09, 0x0a, 0x0d];
// No Name and no control alias: their only aliases in NameAliases.txt are of type `figment`.
const UNNAMED_CONTROLS = [0x80, 0x81, 0x99];

describe('the generated name table (CAS-012, review of db10902)', () => {
  it('names every assigned code point the running rule names, and the three line characters', () => {
    const named = [...prohibitedCodePoints(), ...LINE_CHARACTERS];
    const unnamed = named.filter(
      (codePoint) =>
        ASSIGNED.test(String.fromCodePoint(codePoint)) && codePointName(codePoint) === null,
    );
    expect(unnamed).toEqual(UNNAMED_CONTROLS);
  });

  it('holds nothing the rule does not name, and no name for an unassigned code point or a noncharacter', () => {
    const named = new Set([...prohibitedCodePoints(), ...LINE_CHARACTERS]);
    for (const [codePoint, name] of UNICODE_NAMES) {
      expect([codePoint, named.has(codePoint)]).toEqual([codePoint, true]);
      expect([codePoint, ASSIGNED.test(String.fromCodePoint(codePoint))]).toEqual([
        codePoint,
        true,
      ]);
      expect(name).toMatch(/^[A-Z][A-Z0-9 -]*[A-Z0-9]$/u);
    }
    for (const codePoint of [0x2065, 0xfff0, 0xfffe, 0xffff, 0xe0000, 0xe0002, 0xe01f0, 0x10ffff]) {
      expect([codePoint, codePointName(codePoint)]).toEqual([codePoint, null]);
    }
  });

  it('names each generated range from the character database, controls by their control alias', () => {
    expect(describeCodePoint(0xe0067)).toBe('\\u{E0067} TAG LATIN SMALL LETTER G');
    expect(codePointName(0xe0001)).toBe('LANGUAGE TAG');
    expect(codePointName(0xe0020)).toBe('TAG SPACE');
    expect(codePointName(0xe007e)).toBe('TAG TILDE');
    expect(codePointName(0xe007f)).toBe('CANCEL TAG');
    expect(codePointName(0xfe00)).toBe('VARIATION SELECTOR-1');
    expect(codePointName(0xe0100)).toBe('VARIATION SELECTOR-17');
    expect(codePointName(0xe01ef)).toBe('VARIATION SELECTOR-256');
    expect(codePointName(0x1d173)).toBe('MUSICAL SYMBOL BEGIN BEAM');
    expect(codePointName(0x1bca0)).toBe('SHORTHAND FORMAT LETTER OVERLAP');
    expect(codePointName(0x0000)).toBe('NULL');
    expect(codePointName(0x0085)).toBe('NEXT LINE');
    expect(codePointName(0x009b)).toBe('CONTROL SEQUENCE INTRODUCER');
    expect(codePointName(0x009f)).toBe('APPLICATION PROGRAM COMMAND');
    for (const codePoint of UNNAMED_CONTROLS) {
      expect([codePoint, codePointName(codePoint)]).toEqual([codePoint, null]);
    }
  });
});
