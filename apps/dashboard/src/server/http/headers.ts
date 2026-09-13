import type { DashboardEnvironment } from '../environment.ts';

/**
 * Browser security headers.
 *
 * The content security policy is strict and nonce-based: scripts run only
 * when they carry the per-request nonce (which Next applies to its own
 * inline bootstrap when it sees the nonce in the request's policy), styles
 * come only from this origin, images only from this origin, nothing is
 * framed, nothing is fetched cross-origin, no plugin loads, forms post only
 * here, and `base` is forbidden. There is no `unsafe-inline` and no
 * `unsafe-eval` anywhere, so the app itself may not use an inline style
 * attribute or an inline event handler; it uses CSS classes only.
 *
 * `Strict-Transport-Security` is set only in `production`, because a browser
 * that received it over a local HTTP origin would refuse plain HTTP there for
 * two years.
 *
 * Pure: the same builder serves the proxy, the Next config and the tests.
 */

export const NONCE_HEADER = 'x-cas-nonce';

export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "manifest-src 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'display-capture=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'usb=()',
  'serial=()',
  'bluetooth=()',
  'xr-spatial-tracking=()',
  'interest-cohort=()',
  'browsing-topics=()',
].join(', ');

export const HSTS = 'max-age=63072000; includeSubDomains';

/** Headers applied to every response the app serves. */
export function securityHeaders(
  environment: DashboardEnvironment,
  nonce: string,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': contentSecurityPolicy(nonce),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-DNS-Prefetch-Control': 'off',
  };
  if (environment === 'production') headers['Strict-Transport-Security'] = HSTS;
  return headers;
}

/** Protected responses are never shared: no intermediary may cache them. */
export const NO_STORE = 'private, no-store, max-age=0, must-revalidate';
