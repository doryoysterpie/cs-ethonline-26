import 'server-only';

/**
 * Email identity: conservative normalization, exact comparison.
 *
 * Normalization is trim and lower-case, nothing else. It deliberately does
 * not strip a sub-address (`+tag`), does not remove dots, and does not apply
 * any provider-specific rule: those are properties of one mail provider's
 * routing, not of the address's identity, and "conservative" here means the
 * comparison never treats two syntactically different addresses as the same
 * one. Once normalized, an address is compared for exact, case-sensitive
 * equality — including at the database boundary, where the column this
 * produces is compared with `=`, never `ILIKE` or a collation-dependent
 * comparison.
 */

export const EMAIL_MAX_LENGTH = 254;
/** Conservative and ASCII-only: ample for a normalized address, no Unicode homograph surface. */
const EMAIL_SHAPE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/u;

/** True for a value shaped like an already-normalized email. Shape only; not approval. */
export function isNormalizedEmailShaped(value: unknown): value is string {
  return typeof value === 'string' && value.length <= EMAIL_MAX_LENGTH && EMAIL_SHAPE.test(value);
}

/**
 * Trims and lower-cases a submitted address, then checks its shape. Returns
 * null for anything that is not a plausible address once normalized, rather
 * than throwing: the caller's response to an invalid address is the same
 * generic response as for a well-formed but unapproved one.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > EMAIL_MAX_LENGTH) return null;
  const lower = trimmed.toLowerCase();
  return isNormalizedEmailShaped(lower) ? lower : null;
}
