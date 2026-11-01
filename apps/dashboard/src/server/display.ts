import { escapeOneLine, escapeOneLineParts, type EscapedPart } from '@cas/contracts';

/**
 * Safe display of hostile stored text.
 *
 * React escapes markup, so a stored `<script>` renders as text. What React
 * does not do is make an invisible character visible: a control, a line
 * separator, a bidirectional override that reverses the reading order of
 * everything after it, or any other character that renders as nothing.
 * `safeText` and `safeParts` render every character the prohibited-text rule
 * names, and tab, line feed and carriage return, as a visible escape in the
 * one form (`\u{202E}`, D50; `@cas/contracts`) and bound the length with a
 * visible marker, so a hostile title can neither hide content nor re-order a
 * line in the reader's eye. `safeParts` keeps each escape apart, for the grid to
 * style it distinctly from body text.
 *
 * This module is pure and is shared by server components and unit tests.
 */

/** Display copies longer than this are truncated with a visible marker. */
export const DISPLAY_MAX_LENGTH = 300;

/** True when the value carries a character `safeText` would escape. */
export function hasEscapedCharacter(value: string): boolean {
  return escapeOneLineParts(value).some((part) => part.escape);
}

/** Every character the rule names, and tab, line feed and carriage return, as a visible escape; never truncated. */
export function visibleControls(value: string): string {
  return escapeOneLine(value);
}

/**
 * The value as parts, escapes apart from text, bounded to `maxLength`
 * characters with a visible marker; an escape is never split by the bound.
 */
export function safeParts(value: unknown, maxLength: number = DISPLAY_MAX_LENGTH): EscapedPart[] {
  const text = typeof value === 'string' ? value : value === null ? '' : String(value);
  const parts = escapeOneLineParts(text);
  const total = parts.reduce((length, part) => length + part.text.length, 0);
  if (total <= maxLength) return parts;
  const kept: EscapedPart[] = [];
  let used = 0;
  for (const part of parts) {
    const room = maxLength - used;
    if (room <= 0) break;
    if (part.text.length <= room) {
      kept.push(part);
      used += part.text.length;
    } else {
      if (!part.escape) {
        kept.push({ text: part.text.slice(0, room), escape: false });
        used += room;
      }
      break;
    }
  }
  return [...kept, { text: `…[+${total - used} chars]`, escape: false }];
}

/** `safeParts` as one string, for a context that cannot style an escape. */
export function safeText(value: unknown, maxLength: number = DISPLAY_MAX_LENGTH): string {
  return safeParts(value, maxLength)
    .map((part) => part.text)
    .join('');
}

/** The editorial clock (D10): one zone, always shown with its offset so the instant is unambiguous. */
export const EDITORIAL_TIME_ZONE = 'America/Toronto';

/**
 * An instant for the shell's "as of" line (CAS-010, decision 1): the
 * calendar date and minute in the editorial zone, the zone's name and its
 * UTC offset at that instant, so a reader anywhere can place it. Null, or an
 * instant that does not parse, renders as a dash: nothing is invented.
 */
export function formatAsOf(instant: string | null): string {
  if (instant === null) return '—';
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EDITORIAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(at));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const offset = part('timeZoneName').replace(/^GMT/u, 'UTC').replace(/^UTC$/u, 'UTC+00:00');
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} ${EDITORIAL_TIME_ZONE} (${offset})`;
}
