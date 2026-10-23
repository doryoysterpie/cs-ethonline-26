import { NextResponse, type NextRequest } from 'next/server';

import { sessionCookieName } from './server/auth/cookie.ts';
import { readEnvironment } from './server/environment.ts';
import { NO_STORE, NONCE_HEADER, PATHNAME_HEADER, securityHeaders } from './server/http/headers.ts';

/**
 * The request proxy: per-request nonce, security headers on every response,
 * and an early redirect to the sign-in page for a browser that has no session
 * cookie at all.
 *
 * The redirect is a convenience, not a control. It looks only at whether the
 * cookie exists; it validates nothing and it is bypassable by design (a
 * request that carries any cookie value reaches the page). Every page, action
 * and handler resolves the principal through the session service and the
 * data-access layer refuses on its own. Nothing downstream reads a header set
 * here as proof of anything.
 *
 * This module imports no database code: the environment is read from a
 * dependency-free helper so the proxy bundle stays free of secrets and
 * drivers.
 */

const PUBLIC_PATHS = new Set([
  '/login',
  '/login/verify',
  '/signup',
  '/signup/verify',
  '/robots.txt',
  '/api/me',
  '/api/logout',
]);

/**
 * Paths served without a session (CAS-009, D48): a story card and its two
 * images, at an unguessable address. Never indexed (`X-Robots-Tag`), never in
 * a sitemap; the images may be cached for five minutes, the page never, so
 * each view of it reaches the origin and is counted.
 */
const PUBLIC_PREFIXES = ['/cards/'];
const CARD_IMAGE = /^\/cards\/[A-Za-z0-9_-]{22}\/image\.(?:png|svg)$/u;
const CARD_IMAGE_CACHE = 'public, max-age=300';

function nonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

export function proxy(request: NextRequest): NextResponse {
  const environment = readEnvironment(process.env) ?? 'production';
  const value = nonce();
  const policy = securityHeaders(environment, value);

  const requestHeaders = new Headers(request.headers);
  // Next reads the nonce for its own inline bootstrap from the request's CSP.
  requestHeaders.set('content-security-policy', policy['Content-Security-Policy'] ?? '');
  requestHeaders.set(NONCE_HEADER, value);
  requestHeaders.set(PATHNAME_HEADER, request.nextUrl.pathname);

  const path = request.nextUrl.pathname;
  const hasCookie = request.cookies.has(sessionCookieName(environment));
  let response: NextResponse;
  const publicPrefix = PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
  if (!hasCookie && !PUBLIC_PATHS.has(path) && !publicPrefix && !path.startsWith('/api/')) {
    const target = request.nextUrl.clone();
    target.pathname = '/login';
    target.search = '';
    response = NextResponse.redirect(target);
  } else {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

  for (const [name, headerValue] of Object.entries(policy)) response.headers.set(name, headerValue);
  response.headers.set('Cache-Control', CARD_IMAGE.test(path) ? CARD_IMAGE_CACHE : NO_STORE);
  if (publicPrefix) response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
