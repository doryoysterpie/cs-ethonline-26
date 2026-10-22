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

/**
 * The throttling key for a request. With no trusted proxy declared every
 * request is `direct`. Behind trusted proxies the key is the address the
 * outermost trusted proxy saw as its client: counted from the right end of
 * `X-Forwarded-For`, because each proxy appends what it saw and the left end
 * is whatever the client chose to send (CAS-006, release blocker 3). A header
 * with fewer entries than trusted hops did not pass through the declared
 * chain and keys as `malformed`, as does an entry that is not an address.
 */
export function networkKey(headers: Headers, config: DashboardConfig): string {
  if (!config.trustForwardedFor) return 'direct';
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded === null) return 'direct';
  const entries = forwarded.split(',').map((entry) => entry.trim());
  const index = entries.length - config.trustedProxyHops;
  if (index < 0) return 'malformed';
  const chosen = entries[index] ?? '';
  return ADDRESS.test(chosen) ? chosen.toLowerCase() : 'malformed';
}
