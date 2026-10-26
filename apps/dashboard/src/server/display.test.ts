import { describe, expect, it } from 'vitest';

import {
  DISPLAY_MAX_LENGTH,
  formatAsOf,
  hasEscapedCharacter,
  safeText,
  visibleControls,
} from './display.ts';

const cp = (code: number): string => String.fromCodePoint(code);

describe('safe display text', () => {
  it('renders controls, separators and bidi overrides as visible escapes', () => {
    const hostile = `a${cp(0x1b)}[31mb\nc${cp(0x2028)}d${cp(0x202e)}e${cp(0x2066)}f${cp(0x7f)}g${cp(0x9b)}h`;
    expect(visibleControls(hostile)).toBe('a\\x1b[31mb\\nc\\u2028d\\u202ee\\u2066f\\x7fg\\x9bh');
    expect(hasEscapedCharacter(hostile)).toBe(true);
    expect(hasEscapedCharacter('plain text with émojis 🎉')).toBe(false);
  });

  it('leaves markup as text for React to escape and bounds the length visibly', () => {
    expect(safeText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
    const long = 'x'.repeat(DISPLAY_MAX_LENGTH + 50);
    expect(safeText(long)).toBe(`${'x'.repeat(DISPLAY_MAX_LENGTH)}…[+50 chars]`);
    expect(safeText(long, 10)).toBe(`${'x'.repeat(10)}…[+${DISPLAY_MAX_LENGTH + 40} chars]`);
    expect(safeText(null)).toBe('');
    expect(safeText(42)).toBe('42');
  });

  it('renders the as-of instant in America/Toronto with the UTC offset, and a dash for nothing (CAS-010)', () => {
    expect(formatAsOf('2026-10-23T06:52:07.000Z')).toBe(
      '2026-10-23 02:52 America/Toronto (UTC-04:00)',
    );
    expect(formatAsOf('2026-01-15T03:05:00Z')).toBe('2026-01-14 22:05 America/Toronto (UTC-05:00)');
    expect(formatAsOf('2026-03-08T07:30:00Z')).toBe('2026-03-08 03:30 America/Toronto (UTC-04:00)');
    expect(formatAsOf(null)).toBe('—');
    expect(formatAsOf('not an instant')).toBe('—');
  });
});
