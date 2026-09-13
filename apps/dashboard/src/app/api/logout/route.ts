import { clearingCookieHeader } from '../../../server/auth/cookie.ts';
import { assertHandlerRequest, principalFromRequest } from '../../../server/dal/principal.ts';
import { publicMessage, statusFor, unauthenticated } from '../../../server/errors.ts';
import { NO_STORE } from '../../../server/http/headers.ts';

export const dynamic = 'force-dynamic';

/**
 * Sign-out as a route handler. Requires a valid session, a same-origin
 * request and the session-bound CSRF token in `x-csrf-token`. Revokes the
 * session and clears the cookie.
 */
export async function POST(request: Request): Promise<Response> {
  const { runtime, principal } = await principalFromRequest(request);
  if (principal === null) {
    return new Response(null, {
      status: statusFor(unauthenticated('session_required')),
      headers: { 'Cache-Control': NO_STORE },
    });
  }
  try {
    assertHandlerRequest(principal, request);
  } catch (error) {
    return Response.json(
      { error: publicMessage(error) },
      { status: statusFor(error), headers: { 'Cache-Control': NO_STORE } },
    );
  }
  await runtime.sessions.logout(principal);
  return new Response(null, {
    status: 204,
    headers: {
      'Cache-Control': NO_STORE,
      'Set-Cookie': clearingCookieHeader(runtime.config.environment),
    },
  });
}
