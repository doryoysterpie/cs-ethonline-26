import { describe, expect, it } from 'vitest';

import {
  PERMITTED_DEFAULT_IGNORABLES,
  escapeCodePoint,
  prohibitedCodePoints,
} from '@cas/contracts';

import {
  DISPLAY_MAX_LENGTH,
  ESCAPE_CHARACTER,
  hasControlCharacter,
  safeDisplay,
  toSingleLine,
} from './display.js';

const CSI = String.fromCharCode(0x9b);
const DEL = String.fromCharCode(0x7f);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

describe('toSingleLine', () => {
  it('escapes every newline, carriage return and tab visibly', () => {
    expect(toSingleLine('a\nb')).toBe('a\\u{000A}b');
    expect(toSingleLine('a\r\nb')).toBe('a\\u{000D}\\u{000A}b');
    expect(toSingleLine('a\tb')).toBe('a\\u{0009}b');
  });

  it('escapes ANSI introducers, C0, DEL, C1 and the Unicode separators', () => {
    expect(toSingleLine(`${ESCAPE_CHARACTER}[31mred`)).toBe('\\u{001B}[31mred');
    expect(toSingleLine(String.fromCharCode(0x01))).toBe('\\u{0001}');
    expect(toSingleLine(DEL)).toBe('\\u{007F}');
    expect(toSingleLine(CSI)).toBe('\\u{009B}');
    expect(toSingleLine(LINE_SEPARATOR)).toBe('\\u{2028}');
    expect(toSingleLine(PARAGRAPH_SEPARATOR)).toBe('\\u{2029}');
  });

  it('leaves ordinary text, spaces and non-ASCII letters untouched', () => {
    expect(toSingleLine('Content @latestincyber - CS79.csv')).toBe(
      'Content @latestincyber - CS79.csv',
    );
    expect(toSingleLine('rapport été.csv')).toBe('rapport été.csv');
  });

  it('never truncates and never emits a physical line break', () => {
    // 10,000 ordinary characters plus one newline rendered as the eight
    // characters of its escape, `\u{000A}`.
    const long = `${'x'.repeat(5000)}\n${'y'.repeat(5000)}`;
    const rendered = toSingleLine(long);
    expect(rendered).toHaveLength(10_008);
    expect(rendered.includes('\n')).toBe(false);
  });
});

describe('safeDisplay', () => {
  it('bounds the length with a visible marker', () => {
    const rendered = safeDisplay('z'.repeat(DISPLAY_MAX_LENGTH + 50));
    expect(rendered.startsWith('z'.repeat(DISPLAY_MAX_LENGTH))).toBe(true);
    expect(rendered.endsWith('…[+50 chars]')).toBe(true);
    expect(rendered.includes('\n')).toBe(false);
  });

  it('escapes before measuring, so an escaped run counts against the bound', () => {
    const rendered = safeDisplay('\n'.repeat(DISPLAY_MAX_LENGTH));
    expect(rendered).toContain('…[+');
    expect(rendered.includes('\n')).toBe(false);
  });

  it('leaves a short ordinary name exactly as it is', () => {
    expect(safeDisplay('weekly-synthetic.csv')).toBe('weekly-synthetic.csv');
  });
});

describe('hasControlCharacter', () => {
  it('detects C0, DEL, C1 and the Unicode separators, and only those', () => {
    for (const value of [
      'a\nb',
      'a\rb',
      'a\tb',
      `a${ESCAPE_CHARACTER}b`,
      `a${DEL}b`,
      `a${CSI}b`,
      `a${LINE_SEPARATOR}b`,
      `a${PARAGRAPH_SEPARATOR}b`,
    ]) {
      expect(hasControlCharacter(value), JSON.stringify(value)).toBe(true);
    }
    for (const value of ['CS79', 'a file with spaces.csv', 'été', '', 'a-b_c.9']) {
      expect(hasControlCharacter(value), value).toBe(false);
    }
  });

  it('escapes every code point the prohibited-text rule names, in the one form, and never splits one (CAS-012, D50)', () => {
    for (const code of prohibitedCodePoints()) {
      expect([code, toSingleLine(`A${String.fromCodePoint(code)}B`)]).toEqual([
        code,
        `A${escapeCodePoint(code)}B`,
      ]);
    }
    for (const code of PERMITTED_DEFAULT_IGNORABLES) {
      const heart = `A${String.fromCodePoint(0x2764, code)}B`;
      expect(toSingleLine(heart)).toBe(heart);
    }
    const shown = safeDisplay(
      `${'x'.repeat(DISPLAY_MAX_LENGTH - 3)}${String.fromCodePoint(0x200b)}tail`,
    );
    expect(shown.startsWith(`${'x'.repeat(DISPLAY_MAX_LENGTH - 3)}…[+`)).toBe(true);
  });
});
