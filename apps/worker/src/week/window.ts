import { IngestionError } from '../editorial/errors.js';

/**
 * The editorial week, as D10 resolved it on 22 October 2026: a window from one
 * Saturday at 23:59 to the next Saturday at 23:59 in `America/Toronto`; the
 * freeze is the close; the publication cutoff is the following Sunday 23:59.
 * No week is inferred from the clock: the caller names the window and this
 * module checks it against the rule, DST included, through the platform's
 * `Intl` and nothing else.
 */

export const EDITORIAL_TIME_ZONE = 'America/Toronto';

export interface WeekWindow {
  readonly timeZone: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly freezeAt: string;
  readonly publicationCutoffAt: string;
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: string;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = FORMATTERS.get(timeZone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(timeZone, cached);
  }
  return cached;
}

export function wallClock(instant: Date, timeZone: string): WallClock {
  const parts = new Map<string, string>();
  for (const part of formatter(timeZone).formatToParts(instant)) parts.set(part.type, part.value);
  const number = (type: string): number => Number(parts.get(type));
  return {
    year: number('year'),
    month: number('month'),
    day: number('day'),
    weekday: parts.get('weekday') ?? '',
    hour: number('hour'),
    minute: number('minute'),
    second: number('second'),
  };
}

function dayNumber(clock: WallClock): number {
  return Math.round(Date.UTC(clock.year, clock.month - 1, clock.day) / 86_400_000);
}

function outsideRule(reason: string): IngestionError {
  return new IngestionError(
    'configuration',
    'window_outside_rule',
    `the window is outside the editorial week rule (D10): ${reason}`,
  );
}

function isSaturdayClose(clock: WallClock): boolean {
  return clock.weekday === 'Sat' && clock.hour === 23 && clock.minute === 59 && clock.second === 0;
}

/**
 * The instant whose wall clock in the zone is 23:59:00 on the local day after
 * `instant`'s local day. Starts from 24 hours later and corrects for a DST
 * shift, so the result is exact across the spring and autumn changes.
 */
function nextDayClose(instant: Date, timeZone: string): Date {
  let candidate = new Date(instant.getTime() + 86_400_000);
  const target = dayNumber(wallClock(instant, timeZone)) + 1;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const clock = wallClock(candidate, timeZone);
    const minutesOff =
      (23 * 60 + 59 - (clock.hour * 60 + clock.minute)) * 60_000 - clock.second * 1000;
    const daysOff = target - dayNumber(clock);
    if (daysOff === 0 && minutesOff === 0) return candidate;
    candidate = new Date(candidate.getTime() + daysOff * 86_400_000 + minutesOff);
  }
  throw outsideRule('the publication cutoff could not be placed in the zone');
}

/**
 * Validates `<isoStart>..<isoEnd>` against D10 and derives the freeze and the
 * publication cutoff. Both bounds must be a Saturday at 23:59:00 in the zone
 * and the end the Saturday seven local days after the start.
 */
export function resolveWeekWindow(
  bounds: { readonly startsAt: string; readonly endsAt: string } | undefined,
  timeZone: string = EDITORIAL_TIME_ZONE,
): WeekWindow {
  if (bounds === undefined) {
    throw new IngestionError(
      'configuration',
      'window_required',
      '--window is required as <isoStart>..<isoEnd>; no editorial week is inferred',
    );
  }
  const start = new Date(bounds.startsAt);
  const end = new Date(bounds.endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw outsideRule('the bounds are not instants that end after they start');
  }
  const startClock = wallClock(start, timeZone);
  const endClock = wallClock(end, timeZone);
  if (!isSaturdayClose(startClock)) {
    throw outsideRule('the window must start on a Saturday at 23:59 in the editorial zone');
  }
  if (!isSaturdayClose(endClock)) {
    throw outsideRule('the window must end on a Saturday at 23:59 in the editorial zone');
  }
  if (dayNumber(endClock) - dayNumber(startClock) !== 7) {
    throw outsideRule('the window must end on the Saturday seven days after it starts');
  }
  return {
    timeZone,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    freezeAt: end.toISOString(),
    publicationCutoffAt: nextDayClose(end, timeZone).toISOString(),
  };
}
