import { robotsText } from '../../server/http/robots.ts';

export const dynamic = 'force-static';

/** The fixed, versioned robots.txt (CAS-007). No session, no database, no input. */
export function GET(): Response {
  return new Response(robotsText(), {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
