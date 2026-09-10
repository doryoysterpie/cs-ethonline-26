import { describe, expect, it } from 'vitest';

import { HEADLINE_MAX_CHARACTERS, PUBLISHER_MAX_CHARACTERS, URL_MAX_CHARACTERS } from './bounds.js';
import { createRedactor } from './safety/redact.js';
import { quoteBoundedEvidence, type BoundedTextField } from './safety/text.js';
import { textFetchMargin } from './store/postgres-store.js';
import { SECRET_API_KEY } from './test-support.js';

/**
 * Truthful truncation of SQL-bounded text. A field arrives as a fetched
 * prefix plus the stored value's true character count, and the display copy
 * must say whether anything the store holds was left out: at the bound, one
 * past it, and far past it, in ASCII, in multibyte Unicode and in content
 * whose escapes expand.
 */

const char = (code: number): string => String.fromCodePoint(code);
const MARGIN = textFetchMargin([SECRET_API_KEY.length]);

/** What the store would fetch for a stored value: the first bound+margin characters. */
function fetched(value: string, bound: number): BoundedTextField {
  const points = [...value];
  return { fragment: points.slice(0, bound + MARGIN).join(''), characters: points.length };
}

function omittedOf(text: string): number {
  const match = /…\[\+(\d+) chars\]$/u.exec(text);
  return match === null ? 0 : Number(match[1]);
}

describe('quoteBoundedEvidence', () => {
  it('keeps null distinct from empty', () => {
    expect(quoteBoundedEvidence(null, 10)).toBeNull();
    expect(quoteBoundedEvidence(undefined, 10)).toBeNull();
    expect(quoteBoundedEvidence({ fragment: '', characters: 0 }, 10)).toEqual({
      text: '',
      truncated: false,
      trust: 'untrusted_quoted_evidence',
    });
  });

  it.each([
    ['ASCII', 'a'],
    ['two-byte Unicode', 'é'],
    ['three-byte Unicode', char(0x6f22)],
  ])('is exact at bound minus one, at the bound and at bound plus one in %s', (_, unit) => {
    for (const bound of [HEADLINE_MAX_CHARACTERS, PUBLISHER_MAX_CHARACTERS, URL_MAX_CHARACTERS]) {
      const below = quoteBoundedEvidence(fetched(unit.repeat(bound - 1), bound), bound);
      expect(below).toMatchObject({ truncated: false });
      expect([...(below?.text ?? '')]).toHaveLength(bound - 1);
      const exact = quoteBoundedEvidence(fetched(unit.repeat(bound), bound), bound);
      expect(exact).toMatchObject({ truncated: false });
      expect([...(exact?.text ?? '')]).toHaveLength(bound);
      const above = quoteBoundedEvidence(fetched(unit.repeat(bound + 1), bound), bound);
      expect(above?.truncated).toBe(true);
      expect(above?.text.endsWith('…[+1 chars]')).toBe(true);
      expect([...(above?.text ?? '')].length).toBe(bound + '…[+1 chars]'.length);
    }
  });

  it('counts the characters the store never fetched as omitted', () => {
    const stored = 'legal text '.repeat(4800).slice(0, 48_000);
    const quoted = quoteBoundedEvidence(
      fetched(stored, HEADLINE_MAX_CHARACTERS),
      HEADLINE_MAX_CHARACTERS,
    );
    expect(quoted?.truncated).toBe(true);
    expect(omittedOf(quoted?.text ?? '')).toBe(48_000 - HEADLINE_MAX_CHARACTERS);
    expect(quoted?.text.startsWith(stored.slice(0, HEADLINE_MAX_CHARACTERS))).toBe(true);
    expect(quoted?.text.length).toBeLessThanOrEqual(HEADLINE_MAX_CHARACTERS + 32);
  });

  it('never cuts an escape in half, and counts escape expansion against the bound', () => {
    const stored = '<'.repeat(HEADLINE_MAX_CHARACTERS);
    const quoted = quoteBoundedEvidence(
      fetched(stored, HEADLINE_MAX_CHARACTERS),
      HEADLINE_MAX_CHARACTERS,
    );
    expect(quoted?.truncated).toBe(true);
    // Six display characters per angle bracket: fifty fit whole, two hundred
    // and fifty do not, and the fifty-first is not begun.
    expect(quoted?.text).toBe(`${'\\u003c'.repeat(50)}…[+250 chars]`);
    expect(omittedOf(quoted?.text ?? '')).toBe(250);
    const controls = `${char(0x2028)}`.repeat(10) + 'x'.repeat(HEADLINE_MAX_CHARACTERS);
    const mixed = quoteBoundedEvidence(
      fetched(controls, HEADLINE_MAX_CHARACTERS),
      HEADLINE_MAX_CHARACTERS,
    );
    expect(mixed?.text.startsWith('\\u2028'.repeat(10))).toBe(true);
    expect(mixed?.text).not.toMatch(/\\u20…/u);
    expect(mixed?.truncated).toBe(true);
  });

  it('handles astral code points as one stored character and two display units', () => {
    const emoji = char(0x1f600);
    const stored = emoji.repeat(200);
    const field = fetched(stored, HEADLINE_MAX_CHARACTERS);
    expect(field.characters).toBe(200);
    const quoted = quoteBoundedEvidence(field, HEADLINE_MAX_CHARACTERS);
    // One hundred and fifty emoji fill three hundred UTF-16 units; fifty are omitted.
    expect(quoted?.truncated).toBe(true);
    expect(omittedOf(quoted?.text ?? '')).toBe(50);
    expect(quoted?.text.startsWith(emoji.repeat(150))).toBe(true);
    expect(quoted?.text.length).toBeLessThanOrEqual(HEADLINE_MAX_CHARACTERS + 32);
  });

  it('redacts a secret that crosses the display boundary before cutting, so no prefix of it leaks', () => {
    const redact = createRedactor([SECRET_API_KEY]);
    const bound = HEADLINE_MAX_CHARACTERS;
    // The secret starts twenty characters before the bound and ends after it.
    const stored = 'x'.repeat(bound - 20) + SECRET_API_KEY + 'y'.repeat(5000);
    const quoted = quoteBoundedEvidence(fetched(stored, bound), bound, redact);
    expect(quoted?.text).toContain('[REDACTED]');
    expect(quoted?.text).not.toContain(SECRET_API_KEY);
    expect(quoted?.text).not.toContain(SECRET_API_KEY.slice(0, 6));
    expect(quoted?.truncated).toBe(true);
    // Without the margin the store would have fetched only the bound, splitting
    // the secret: the margin is at least three times its length.
    expect(MARGIN).toBeGreaterThanOrEqual(3 * SECRET_API_KEY.length);
  });

  it('reports a fully fetched, redacted value as complete when its display copy fits', () => {
    const redact = createRedactor([SECRET_API_KEY]);
    const stored = 'x'.repeat(280) + SECRET_API_KEY;
    const quoted = quoteBoundedEvidence(
      { fragment: stored, characters: [...stored].length },
      HEADLINE_MAX_CHARACTERS,
      redact,
    );
    expect(quoted).toEqual({
      text: `${'x'.repeat(280)}[REDACTED]`,
      truncated: false,
      trust: 'untrusted_quoted_evidence',
    });
  });
});

describe('textFetchMargin', () => {
  it('sizes the sentinel from the longest secret, within its limits', () => {
    expect(textFetchMargin([])).toBe(64);
    expect(textFetchMargin([4])).toBe(64);
    expect(textFetchMargin([34])).toBe(3 * 34 + 16);
    expect(textFetchMargin([34, 120])).toBe(3 * 120 + 16);
    expect(textFetchMargin([10_000])).toBe(512);
  });
});
