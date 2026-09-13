import { NO_STORE } from '../../../server/http/headers.ts';

export const dynamic = 'force-dynamic';

/**
 * The deployment health check. Proves only that the process is up and
 * answering requests: no configuration value, no database state, no
 * dependency version and no build identifier is ever in the response.
 * Reachable without a session (`proxy.ts` exempts every `/api/*` path from
 * the sign-in redirect).
 */
export async function GET(): Promise<Response> {
  return new Response(null, { status: 200, headers: { 'Cache-Control': NO_STORE } });
}
