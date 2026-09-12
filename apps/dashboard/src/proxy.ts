import { NextResponse, type NextRequest } from 'next/server';

import { sessionCookieName } from './server/auth/cookie.ts';
import { readEnvironment } from './server/environment.ts';
import { NO_STORE, NONCE_HEADER, securityHeaders } from './server/http/headers.ts';

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

const PUBLIC_PATHS = new Set(['/login', '/api/me', '/api/logout']);

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

  const path = request.nextUrl.pathname;
  const hasCookie = request.cookies.has(sessionCookieName(environment));
  let response: NextResponse;
  if (!hasCookie && !PUBLIC_PATHS.has(path) && !path.startsWith('/api/')) {
    const target = request.nextUrl.clone();
    target.pathname = '/login';
    target.search = '';
    response = NextResponse.redirect(target);
  } else {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

  for (const [name, headerValue] of Object.entries(policy)) response.headers.set(name, headerValue);
  response.headers.set('Cache-Control', NO_STORE);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
