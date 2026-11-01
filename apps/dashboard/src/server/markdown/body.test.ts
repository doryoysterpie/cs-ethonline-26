import { describe, expect, it } from 'vitest';

import {
  PERMITTED_DEFAULT_IGNORABLES,
  hasProhibitedText,
  prohibitedCodePoints,
} from '@cas/contracts';

import { isDashboardError } from '../errors.ts';
import { cleanedBody } from './body.ts';

const char = (code: number): string => String.fromCodePoint(code);
// D50, point 1: the refused set is a property, not a list.
const CONTROL_OR_BIDI = /^[\p{Cc}\p{Bidi_Control}]$/u;
const REFUSED = {
  test: (value: string) => CONTROL_OR_BIDI.test(value) && !'\t\n\r'.includes(value),
};

function outcome(markdown: string, max = 1_000): unknown {
  try {
    return cleanedBody(markdown, 'draft', max);
  } catch (error) {
    if (!isDashboardError(error)) throw error;
    return { code: error.code, characters: error.characters };
  }
}

describe('the save path over every code point the rule names (CAS-012, review of db10902)', () => {
  it('refuses each control and bidirectional control and strips each other code point, where it stands', () => {
    const wrong: string[] = [];
    for (const codePoint of prohibitedCodePoints()) {
      // Line 2, column 3 of the text as submitted.
      const result = outcome(`First line\nab${char(codePoint)}cd`);
      const at = { codePoint, line: 2, column: 3 };
      const expected = REFUSED.test(char(codePoint))
        ? {
            code: 'markdown_control',
            characters: [expect.objectContaining(at)],
          }
        : { body: 'First line\nabcd', removed: [expect.objectContaining(at)] };
      try {
        expect(result).toEqual(expected);
      } catch {
        wrong.push(codePoint.toString(16));
      }
    }
    expect(wrong).toEqual([]);
  });

  it('keeps U+FE0E and U+FE0F, tab, line feed and carriage return, and stores nothing the rule names', () => {
    const kept = `a${char(0x2764)}${char(0xfe0f)}\tb${char(0x2764)}${char(0xfe0e)}\r\nc`;
    expect(PERMITTED_DEFAULT_IGNORABLES).toEqual([0xfe0e, 0xfe0f]);
    expect(cleanedBody(kept, 'draft', 1_000)).toEqual({ body: kept, removed: [] });
    const strippable = prohibitedCodePoints().filter((codePoint) => !REFUSED.test(char(codePoint)));
    const cleaned = cleanedBody(`x${strippable.map(char).join('')}y`, 'draft', 100_000);
    expect(cleaned.body).toBe('xy');
    expect(hasProhibitedText(cleaned.body)).toBe(false);
    expect(cleaned.removed.map((located) => located.codePoint)).toEqual(strippable);
    expect(cleaned.removed.map((located) => located.column)).toEqual(
      strippable.map((_, index) => index + 2),
    );
  });

  it('reports every removal, past any count a notice could carry in a URL', () => {
    const many = Array.from({ length: 25 }, (_, index) => `w${index}${char(0x200b)}`).join(' ');
    const { removed } = cleanedBody(many, 'draft', 1_000);
    expect(removed).toHaveLength(25);
    expect(new Set(removed.map((located) => located.column)).size).toBe(25);
  });

  it('bounds the stored body in code points, after the strip (astral boundaries)', () => {
    const max = 10;
    // Ten code points, eleven code units: stored as it stands.
    expect(outcome(`${'a'.repeat(9)}${char(0x1f600)}`, max)).toEqual({
      body: `${'a'.repeat(9)}${char(0x1f600)}`,
      removed: [],
    });
    // Eleven code points, one of them removable and astral: stripped, then within the bound.
    expect(outcome(`${'a'.repeat(10)}${char(0xe0067)}`, max)).toEqual({
      body: 'a'.repeat(10),
      removed: [expect.objectContaining({ codePoint: 0xe0067, line: 1, column: 11 })],
    });
    // A refused astral-adjacent character at the bound is named, not measured.
    expect(outcome(`${'a'.repeat(10)}${char(0x202e)}`, max)).toEqual({
      code: 'markdown_control',
      characters: [expect.objectContaining({ codePoint: 0x202e, line: 1, column: 11 })],
    });
    expect(outcome('a'.repeat(11), max)).toMatchObject({ code: 'markdown_length' });
    expect(outcome('', max)).toMatchObject({ code: 'markdown_length' });
    expect(outcome(char(0xe0067), max)).toMatchObject({ code: 'markdown_length' });
    // The walk bound: more than four times the maximum in code units.
    expect(outcome('a'.repeat(41), max)).toMatchObject({ code: 'markdown_length' });
    expect(outcome(`${'a'.repeat(10)}${char(0x200b).repeat(30)}`, max)).toMatchObject({
      body: 'a'.repeat(10),
    });
  });
});
