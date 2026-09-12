import 'server-only';

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session tokens and the tokens derived from them.
 *
 * A session token is 32 bytes from the CSPRNG, encoded as base64url. The
 * store keeps only its SHA-256, so a copy of the store cannot be replayed as
 * a session. The token itself travels in one cookie and nowhere else.
 *
 * The CSRF token is derived from the session token by HMAC rather than
 * stored: only a request that carries the session cookie can be answered
 * with the matching CSRF token, and a cross-site request that carries the
 * cookie implicitly still cannot read it, so it cannot compute the token.
 * Comparison is constant-time.
 */

export const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const CSRF_PURPOSE = 'cas-dashboard-csrf@1';

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/** True for a value shaped like a token this code issued. Shape only; not validity. */
export function isSessionTokenShaped(value: unknown): value is string {
  return typeof value === 'string' && SESSION_TOKEN.test(value);
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function csrfTokenFor(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update(CSRF_PURPOSE, 'utf8').digest('base64url');
}

/** Constant-time equality of two strings, false when the lengths differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
