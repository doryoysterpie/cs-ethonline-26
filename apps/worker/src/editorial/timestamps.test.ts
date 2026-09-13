import { describe, expect, it } from 'vitest';

import { parseStrictTimestamp } from './timestamps.js';

describe('parseStrictTimestamp', () => {
  it('accepts UTC and offset forms and converts to a UTC instant', () => {
    expect(parseStrictTimestamp('2026-08-31T14:05:00.000Z')).toEqual({
      ok: true,
      isoUtc: '2026-08-31T14:05:00.000Z',
    });
    expect(parseStrictTimestamp('2026-08-23T12:00:00+02:00')).toEqual({
      ok: true,
      isoUtc: '2026-08-23T10:00:00Z',
    });
    expect(parseStrictTimestamp('2026-01-01T00:30:00-05:30')).toEqual({
      ok: true,
      isoUtc: '2026-01-01T06:00:00Z',
    });
  });

  it('keeps up to six fraction digits and cuts, never rounds, the rest', () => {
    expect(parseStrictTimestamp('2026-08-23T12:00:00.123456789Z')).toEqual({
      ok: true,
      isoUtc: '2026-08-23T12:00:00.123456Z',
    });
    expect(parseStrictTimestamp('2026-08-23T12:00:00.9999999Z')).toEqual({
      ok: true,
      isoUtc: '2026-08-23T12:00:00.999999Z',
    });
  });

  it('rejects naive, partial, lenient and impossible values', () => {
    for (const raw of [
      '2026-09-01T10:00:00',
      '2026-09-01',
      'September 1, 2026',
      '2026-13-45T25:61:00.000Z',
      '2026-02-30T00:00:00Z',
      '2026-08-23T24:00:00Z',
      '2026-08-23T12:00:00+24:00',
      '2026-08-23 12:00:00Z',
      ' 2026-08-23T12:00:00Z',
      '',
      'not a timestamp',
    ]) {
      expect(parseStrictTimestamp(raw), raw).toEqual({ ok: false });
    }
  });

  it('accepts leap days only when they exist', () => {
    expect(parseStrictTimestamp('2028-02-29T00:00:00Z').ok).toBe(true);
    expect(parseStrictTimestamp('2027-02-29T00:00:00Z').ok).toBe(false);
  });
});
