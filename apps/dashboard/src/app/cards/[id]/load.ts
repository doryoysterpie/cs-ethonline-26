import 'server-only';

import { headers } from 'next/headers';
import { cache } from 'react';

import { cardPage, type CardPageDto } from '../../../server/dal/cards.ts';
import { isDashboardError } from '../../../server/errors.ts';
import { networkKey } from '../../../server/http/network.ts';
import { getRuntime } from '../../../server/runtime.ts';

export type CardLoad =
  | { readonly kind: 'card'; readonly view: CardPageDto; readonly publicUrl: string | null }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'limited' }
  | { readonly kind: 'unavailable' };

/**
 * One read per request, shared by the page and its metadata through React's
 * request cache, so a view is counted once (CAS-009, D48, decision 4).
 */
export const loadCard = cache(async (id: string): Promise<CardLoad> => {
  const runtime = await getRuntime();
  try {
    const view = await cardPage(runtime, id, networkKey(await headers(), runtime.config));
    return { kind: 'card', view, publicUrl: runtime.publicUrl };
  } catch (error) {
    if (isDashboardError(error) && error.kind === 'not_found') return { kind: 'not_found' };
    if (isDashboardError(error) && error.kind === 'throttled') return { kind: 'limited' };
    return { kind: 'unavailable' };
  }
});
