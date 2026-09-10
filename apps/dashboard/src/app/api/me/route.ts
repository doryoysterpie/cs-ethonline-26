import { principalFromRequest } from '../../../server/dal/principal.ts';
import { describePrincipal } from '../../../server/dal/read.ts';
import { NO_STORE } from '../../../server/http/headers.ts';
import { statusFor, unauthenticated } from '../../../server/errors.ts';

export const dynamic = 'force-dynamic';

/**
 * Who am I. Answers 401 with an empty body for any request without a valid
 * session, and a minimal principal DTO otherwise. Never cached.
 */
export async function GET(request: Request): Promise<Response> {
  const { principal } = await principalFromRequest(request);
  if (principal === null) {
    return new Response(null, {
      status: statusFor(unauthenticated('session_required')),
      headers: { 'Cache-Control': NO_STORE },
    });
  }
  return Response.json(describePrincipal(principal), { headers: { 'Cache-Control': NO_STORE } });
}
