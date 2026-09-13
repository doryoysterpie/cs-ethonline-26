/**
 * Strict, timezone-aware timestamp parsing. Accepts only the ISO 8601
 * profile `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)` with a real calendar
 * date. A naive timestamp (no offset), a date without time, or anything the
 * lenient `Date.parse` would guess at is rejected. The raw string is always
 * preserved by the caller; this function only produces the UTC instant.
 */

const STRICT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

export type TimestampParse =
  { readonly ok: true; readonly isoUtc: string } | { readonly ok: false };

const REJECTED: TimestampParse = { ok: false };

export function parseStrictTimestamp(raw: string): TimestampParse {
  const match = STRICT.exec(raw);
  if (match === null) return REJECTED;
  const [, y, mo, d, h, mi, s, fraction, offset] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return REJECTED;
  }
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(utcMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return REJECTED;
  }
  let offsetMinutes = 0;
  if (offset !== undefined && offset !== 'Z') {
    const sign = offset.startsWith('-') ? -1 : 1;
    const oh = Number(offset.slice(1, 3));
    const om = Number(offset.slice(4, 6));
    if (oh > 23 || om > 59) return REJECTED;
    offsetMinutes = sign * (oh * 60 + om);
  }
  const instant = new Date(utcMs - offsetMinutes * 60_000);
  if (Number.isNaN(instant.getTime())) return REJECTED;
  // PostgreSQL keeps microseconds; longer fractions are cut, never rounded.
  const digits = (fraction ?? '').slice(0, 6);
  const base = instant.toISOString().slice(0, 19);
  return { ok: true, isoUtc: `${base}${digits.length > 0 ? `.${digits}` : ''}Z` };
}
