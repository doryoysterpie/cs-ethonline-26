import { describe, expect, it } from 'vitest';

import {
  PERMITTED_DEFAULT_IGNORABLES,
  hasProhibitedText,
  prohibitedCodePoints,
  prohibitedTextRule,
  removeProhibitedText,
} from './prohibited-text.js';

const char = (code: number): string => String.fromCodePoint(code);

/** Every code point the running Node reports as having the property, surrogates excepted. */
function runtimeSet(property: RegExp): number[] {
  const out: number[] = [];
  for (let code = 0; code <= 0x10ffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    if (property.test(char(code))) out.push(code);
  }
  return out;
}

describe('the prohibited-text rule (D49)', () => {
  it(`prohibits every code point the runtime reports as Default_Ignorable_Code_Point but U+FE0E and U+FE0F (Unicode ${process.versions.unicode})`, () => {
    const ignorable = runtimeSet(/\p{Default_Ignorable_Code_Point}/u);
    expect(ignorable.length).toBeGreaterThan(4000);
    const refused = ignorable.filter((code) => prohibitedTextRule(code) !== null);
    expect(refused).toEqual(
      ignorable.filter((code) => !PERMITTED_DEFAULT_IGNORABLES.includes(code)),
    );
    for (const code of refused) {
      expect(['bidi_control', 'default_ignorable']).toContain(prohibitedTextRule(code));
    }
    expect([...PERMITTED_DEFAULT_IGNORABLES]).toEqual([0xfe0e, 0xfe0f]);
    for (const code of PERMITTED_DEFAULT_IGNORABLES) expect(prohibitedTextRule(code)).toBeNull();
    expect(prohibitedCodePoints()).toEqual(
      runtimeSet(/./su).filter((code) => prohibitedTextRule(code) !== null),
    );
  });

  it('prohibits every control but tab, line feed and carriage return, and every noncharacter', () => {
    const controls = runtimeSet(/\p{Cc}/u);
    expect(controls.filter((code) => prohibitedTextRule(code) === null)).toEqual([
      0x09, 0x0a, 0x0d,
    ]);
    const noncharacters = runtimeSet(/\p{Noncharacter_Code_Point}/u);
    expect(noncharacters).toHaveLength(66);
    for (const code of noncharacters) expect(prohibitedTextRule(code)).toBe('noncharacter');
  });

  it('names the rule each code point breaks', () => {
    const cases: readonly [number, string | null][] = [
      [0x00, 'c0_control'],
      [0x1b, 'c0_control'],
      [0x7f, 'c1_control'],
      [0x9f, 'c1_control'],
      [0x2028, 'line_separator'],
      [0x2029, 'line_separator'],
      [0x061c, 'bidi_control'],
      [0x200e, 'bidi_control'],
      [0x202e, 'bidi_control'],
      [0x2069, 'bidi_control'],
      [0x00ad, 'default_ignorable'],
      [0x034f, 'default_ignorable'],
      [0x180e, 'default_ignorable'],
      [0x200b, 'default_ignorable'],
      [0x200d, 'default_ignorable'],
      [0x2060, 'default_ignorable'],
      [0x3164, 'default_ignorable'],
      [0xfe00, 'default_ignorable'],
      [0xfeff, 'default_ignorable'],
      [0xe0001, 'default_ignorable'],
      [0xe0100, 'default_ignorable'],
      [0xfff9, 'interlinear_annotation'],
      [0xfffb, 'interlinear_annotation'],
      [0xfdd0, 'noncharacter'],
      [0x10ffff, 'noncharacter'],
      [0x09, null],
      [0x41, null],
      [0xa0, null],
      [0x3000, null],
      [0xfe0f, null],
      [0x1f600, null],
    ];
    for (const [code, rule] of cases)
      expect([code, prohibitedTextRule(code)]).toEqual([code, rule]);
  });

  it('removes every occurrence, keeps emoji presentation, and decomposes a joined emoji sequence', () => {
    const hidden = `co${char(0xad)}operate${char(0x200b)} ${char(0x180e)}now${char(0x202e)}`;
    expect(hasProhibitedText(hidden)).toBe(true);
    expect(removeProhibitedText(hidden)).toBe('cooperate now');
    const warning = `${char(0x26a0)}${char(0xfe0f)} alert`;
    expect(hasProhibitedText(warning)).toBe(false);
    expect(removeProhibitedText(warning)).toBe(warning);
    // U+200D is refused bare and stripped inside a sequence: the family emoji decomposes (D49).
    const family = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467].map(char).join('');
    expect(removeProhibitedText(family)).toBe([0x1f468, 0x1f469, 0x1f467].map(char).join(''));
    expect(hasProhibitedText('plain text, with a tab\tand a line\n')).toBe(false);
  });
});
