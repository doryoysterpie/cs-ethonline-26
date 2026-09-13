import { DashboardError } from '../errors.ts';
import { constantTimeEqual, csrfTokenFor } from './tokens.ts';

/**
 * Cross-site request forgery controls for every mutation.
 *
 * Two independent checks, both required:
 *
 *   1. **Same origin.** `Sec-Fetch-Site`, when the browser sends it, must be
 *      `same-origin`. `Origin`, when sent, must name exactly this host. A
 *      request that sends neither header is refused: there is no ambient
 *      authority for a mutation. A `Referer` is never consulted.
 *   2. **A session-bound token.** The submitted CSRF token must equal the HMAC
 *      derived from the session token. It is compared in constant time.
 *
 * Pure: shared by server actions, route handlers and unit tests.
 */

function refusal(code: string): DashboardError {
  return new DashboardError(
    'authorization',
    code,
    'the request did not pass the same-origin check',
  );
}

function expectedOrigins(host: string): readonly string[] {
  return [`https://${host}`, `http://${host}`];
}

const HOST = /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/u;

/**
 * Refuses a mutation that is not demonstrably same-origin. `headers` is the
 * request's own header list; `host` is the request's `Host` header, which
 * Next validates against the configured origin before a server action runs.
 */
export function assertSameOrigin(headers: Headers, host: string | null): void {
  if (host === null || !HOST.test(host)) throw refusal('host_missing');
  const site = headers.get('sec-fetch-site');
  const origin = headers.get('origin');
  if (site !== null && site !== 'same-origin') throw refusal('cross_site');
  if (origin !== null && !expectedOrigins(host).includes(origin)) throw refusal('foreign_origin');
  if (site === null && origin === null) throw refusal('origin_unknown');
}

/** Refuses a mutation whose CSRF token is absent or does not match the session. */
export function assertCsrfToken(sessionToken: string, submitted: unknown): void {
  if (typeof submitted !== 'string' || submitted.length === 0) throw refusal('csrf_missing');
  if (!constantTimeEqual(csrfTokenFor(sessionToken), submitted)) throw refusal('csrf_mismatch');
}

export const CSRF_FIELD = 'csrfToken';
export const CSRF_HEADER = 'x-csrf-token';
