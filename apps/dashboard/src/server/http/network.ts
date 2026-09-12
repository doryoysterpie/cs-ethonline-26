import type { DashboardConfig } from '../config.ts';

/**
 * The network key a login attempt is throttled under.
 *
 * Without a trusted reverse proxy the only honest value is `direct`: a route
 * handler in Next has no socket, so the peer address is unavailable, and an
 * `X-Forwarded-For` header from an untrusted client is whatever the client
 * chose to send. With `DASHBOARD_TRUST_FORWARDED_FOR=true` the first hop is
 * used, bounded and reduced to the characters an address can contain, so a
 * hostile header cannot smuggle text into the audit trail.
 */
const ADDRESS = /^[0-9A-Fa-f.:]{1,45}$/u;

export function networkKey(headers: Headers, config: DashboardConfig): string {
  if (!config.trustForwardedFor) return 'direct';
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded === null) return 'direct';
  const first = forwarded.split(',')[0]?.trim() ?? '';
  return ADDRESS.test(first) ? first.toLowerCase() : 'malformed';
}
