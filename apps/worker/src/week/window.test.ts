import { describe, expect, it } from 'vitest';

import { isIngestionError } from '../editorial/errors.js';
import { resolveWeekWindow, wallClock } from './window.js';

/**
 * D10 as resolved: Saturday 23:59 to Saturday 23:59 in America/Toronto, the
 * publication cutoff the Sunday after at 23:59, DST included. Instants below
 * are UTC; the zone is four hours behind in October (EDT) and five from
 * 1 November 2026 (EST).
 */

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isIngestionError(error)) return error.code;
    throw error;
  }
  return 'none';
}

describe('the editorial week window (D10 resolution)', () => {
  it('accepts a Saturday-to-Saturday 23:59 window and derives the freeze and cutoff', () => {
    const window = resolveWeekWindow({
      startsAt: '2026-10-18T03:59:00.000Z',
      endsAt: '2026-10-25T03:59:00.000Z',
    });
    expect(window).toEqual({
      timeZone: 'America/Toronto',
      windowStart: '2026-10-18T03:59:00.000Z',
      windowEnd: '2026-10-25T03:59:00.000Z',
      freezeAt: '2026-10-25T03:59:00.000Z',
      publicationCutoffAt: '2026-10-26T03:59:00.000Z',
    });
    expect(wallClock(new Date(window.publicationCutoffAt), 'America/Toronto')).toMatchObject({
      weekday: 'Sun',
      hour: 23,
      minute: 59,
    });
  });

  it('counts seven local days across the autumn clock change, not 168 hours', () => {
    // Saturday 31 October 23:59 EDT to Saturday 7 November 23:59 EST: 169 hours.
    const window = resolveWeekWindow({
      startsAt: '2026-11-01T03:59:00.000Z',
      endsAt: '2026-11-08T04:59:00.000Z',
    });
    expect(window.publicationCutoffAt).toBe('2026-11-09T04:59:00.000Z');
    expect(wallClock(new Date(window.windowEnd), 'America/Toronto')).toMatchObject({
      weekday: 'Sat',
      hour: 23,
      minute: 59,
    });
    // The 168-hour window ends at 22:59 EST on the Saturday, which is outside the rule.
    expect(
      codeOf(() =>
        resolveWeekWindow({
          startsAt: '2026-11-01T03:59:00.000Z',
          endsAt: '2026-11-08T03:59:00.000Z',
        }),
      ),
    ).toBe('window_outside_rule');
  });

  it('refuses a missing window, a non-Saturday, a wrong time of day, a six-day span, and the wrong zone', () => {
    expect(codeOf(() => resolveWeekWindow(undefined))).toBe('window_required');
    const cases = [
      ['2026-10-19T03:59:00.000Z', '2026-10-26T03:59:00.000Z'], // Sundays
      ['2026-10-18T04:00:00.000Z', '2026-10-25T04:00:00.000Z'], // Sunday 00:00 local
      ['2026-10-18T03:59:00.000Z', '2026-10-24T03:59:00.000Z'], // six days
      ['2026-10-17T23:59:00.000Z', '2026-10-24T23:59:00.000Z'], // 23:59 UTC, 19:59 local
      ['2026-10-25T03:59:00.000Z', '2026-10-18T03:59:00.000Z'], // reversed
      ['not-a-date', '2026-10-25T03:59:00.000Z'],
    ] as const;
    for (const [startsAt, endsAt] of cases) {
      expect(
        codeOf(() => resolveWeekWindow({ startsAt, endsAt })),
        `${startsAt}..${endsAt}`,
      ).toBe('window_outside_rule');
    }
  });
});
