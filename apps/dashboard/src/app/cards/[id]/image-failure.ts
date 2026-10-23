import 'server-only';

import { isDashboardError } from '../../../server/errors.ts';

/** One fixed answer per failure; nothing about the card or the store is echoed. */
export function imageFailure(error: unknown): Response {
  const plain = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
  if (isDashboardError(error) && error.kind === 'not_found') {
    return new Response('Not found.\n', { status: 404, headers: plain });
  }
  if (isDashboardError(error) && error.kind === 'throttled') {
    return new Response('Too many requests.\n', {
      status: 429,
      headers: { ...plain, 'retry-after': '900' },
    });
  }
  return new Response('Unavailable.\n', { status: 503, headers: plain });
}
