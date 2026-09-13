import 'server-only';

import { cookies, headers } from 'next/headers';

import { readCookie, sessionCookieName } from '../auth/cookie.ts';
import { assertCsrfToken, assertSameOrigin, CSRF_FIELD, CSRF_HEADER } from '../auth/csrf.ts';
import type { Principal } from '../auth/session.ts';
import { csrfTokenFor } from '../auth/tokens.ts';
import { getRuntime, type Runtime } from '../runtime.ts';

/**
 * Resolving the principal of the current request.
 *
 * Pages and server actions read the session cookie through Next's cookie
 * store; route handlers read it from their `Request`. Both paths end in the
 * session service, which is the only thing that decides whether a token is
 * a session. The proxy's early redirect is a convenience and is never
 * consulted here.
 */

export async function currentPrincipal(): Promise<{
  runtime: Runtime;
  principal: Principal | null;
}> {
  const runtime = await getRuntime();
  const jar = await cookies();
  const token = jar.get(sessionCookieName(runtime.config.environment))?.value ?? null;
  const principal = await runtime.sessions.authenticate(token);
  return { runtime, principal };
}

export async function principalFromRequest(
  request: Request,
): Promise<{ runtime: Runtime; principal: Principal | null }> {
  const runtime = await getRuntime();
  const token = readCookie(
    request.headers.get('cookie'),
    sessionCookieName(runtime.config.environment),
  );
  const principal = await runtime.sessions.authenticate(token);
  return { runtime, principal };
}

/** The CSRF token the current principal's forms must carry. */
export function csrfFor(principal: Principal): string {
  return csrfTokenFor(principal.sessionToken);
}

/**
 * Both CSRF checks for a server action: same origin from the request's own
 * headers, then the session-bound token from the form. Throws a fixed
 * authorization failure; never echoes anything submitted.
 */
export async function assertActionRequest(principal: Principal, form: FormData): Promise<void> {
  const list = await headers();
  assertSameOrigin(list, list.get('host'));
  assertCsrfToken(principal.sessionToken, form.get(CSRF_FIELD));
}

/** The same two checks for a route handler, reading the token from a header. */
export function assertHandlerRequest(principal: Principal, request: Request): void {
  assertSameOrigin(request.headers, request.headers.get('host'));
  assertCsrfToken(principal.sessionToken, request.headers.get(CSRF_HEADER));
}
