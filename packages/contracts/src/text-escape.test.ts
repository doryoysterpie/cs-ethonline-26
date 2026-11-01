import { describe, expect, it } from 'vitest';

import { PERMITTED_DEFAULT_IGNORABLES, prohibitedCodePoints } from './prohibited-text.js';
import {
  codePointName,
  describeCodePoint,
  escapeCodePoint,
  escapeMultiLine,
  escapeOneLine,
  escapedCut,
  locateProhibitedText,
} from './text-escape.js';

const char = (code: number): string => String.fromCodePoint(code);

describe('the one escape form (D50, point 3)', () => {
  it('writes every code point as \\u{XXXX}, uppercase, at least four digits, and the form parses back', () => {
    expect(escapeCodePoint(0x0a)).toBe('\\u{000A}');
    expect(escapeCodePoint(0xad)).toBe('\\u{00AD}');
    expect(escapeCodePoint(0x180e)).toBe('\\u{180E}');
    expect(escapeCodePoint(0xe0067)).toBe('\\u{E0067}');
    expect(escapeCodePoint(0x10ffff)).toBe('\\u{10FFFF}');
    for (const code of [0x00, 0x0a, 0x202e, 0xfeff, 0xe0067, 0x10ffff]) {
      // The braced form is a valid escape in a string literal and a u-flag expression.
      expect(JSON.parse(`"${escapeCodePoint(code).replace('\\u{', '\\\\u{')}"`)).toBe(
        escapeCodePoint(code),
      );
      expect(new RegExp(escapeCodePoint(code), 'u').test(char(code))).toBe(true);
    }
  });

  it('adds the name only through describeCodePoint, and only when it is known', () => {
    expect(describeCodePoint(0x200b)).toBe('\\u{200B} ZERO WIDTH SPACE');
    expect(describeCodePoint(0x0a)).toBe('\\u{000A} LINE FEED');
    expect(describeCodePoint(0xfe00)).toBe('\\u{FE00} VARIATION SELECTOR-1');
    expect(describeCodePoint(0xe01ef)).toBe('\\u{E01EF} VARIATION SELECTOR-256');
    expect(describeCodePoint(0xe0067)).toBe('\\u{E0067}');
    expect(codePointName(0x41)).toBeNull();
  });

  it('escapes, in a one-line value, every code point the rule names and the three line characters, bare', () => {
    for (const code of prohibitedCodePoints()) {
      expect([code, escapeOneLine(`A${char(code)}B`)]).toEqual([
        code,
        `A${escapeCodePoint(code)}B`,
      ]);
    }
    expect(escapeOneLine('a\tb\nc\rd')).toBe('a\\u{0009}b\\u{000A}c\\u{000D}d');
    for (const code of PERMITTED_DEFAULT_IGNORABLES) {
      const heart = `A${char(0x2764)}${char(code)}B`;
      expect(escapeOneLine(heart)).toBe(heart);
    }
    const ordinary = `caf${char(0xe9)} ${char(0xa0)} ordinary`;
    expect(escapeOneLine(ordinary)).toBe(ordinary);
  });

  it('keeps tab, line feed and carriage return in a multi-line value and escapes the rest the rule names', () => {
    expect(escapeMultiLine(`line one\n\tline${char(0x202e)} two\r\n`)).toBe(
      'line one\n\tline\\u{202E} two\r\n',
    );
  });

  it('locates each code point the rule names by line and column, counted in code points', () => {
    const value = `first${char(0x00ad)}\n${char(0x1f600)}x${char(0x200b)}\nend${char(0x202e)}`;
    expect(locateProhibitedText(value)).toEqual([
      { codePoint: 0x00ad, rule: 'default_ignorable', line: 1, column: 6 },
      { codePoint: 0x200b, rule: 'default_ignorable', line: 2, column: 3 },
      { codePoint: 0x202e, rule: 'bidi_control', line: 3, column: 4 },
    ]);
    expect(locateProhibitedText('plain\ttext\n')).toEqual([]);
  });

  it('cuts an escaped value without splitting an escape', () => {
    const escaped = escapeOneLine(`ab${char(0x200b)}cd`);
    expect(escaped).toBe('ab\\u{200B}cd');
    expect(escapedCut(escaped, 5)).toBe(2);
    expect(escapedCut(escaped, 10)).toBe(10);
    expect(escapedCut(escaped, 11)).toBe(11);
    expect(escapedCut('short', 10)).toBe(5);
  });
});
