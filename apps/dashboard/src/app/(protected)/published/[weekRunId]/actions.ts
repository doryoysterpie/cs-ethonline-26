'use server';

import { redirect } from 'next/navigation';

import { makeCard } from '../../../../server/dal/cards.ts';
import { assertActionRequest, currentPrincipal } from '../../../../server/dal/principal.ts';
import { isDashboardError } from '../../../../server/errors.ts';
import { readClosedObject } from '../../../../server/input.ts';
import { attempt, noticeCodeFor, withNotice } from '../../../page-support.ts';

const OWN_CODES = new Set(['card_limited', 'story_not_shareable']);

/** Makes, or returns, the card of one published story, and sends the principal to it (CAS-009). */
export async function makeCardAction(form: FormData): Promise<void> {
  let back = '/published';
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return null;
    await assertActionRequest(principal, form);
    const input = readClosedObject(form, [
      'csrfToken',
      'weekRunId',
      'category',
      'output',
      'entryIndex',
    ]);
    if (typeof input.weekRunId === 'string' && typeof input.category === 'string') {
      back = `/published/${encodeURIComponent(input.weekRunId)}?category=${encodeURIComponent(input.category)}&output=${encodeURIComponent(String(input.output))}`;
    }
    return makeCard(runtime, principal, {
      weekRunId: input.weekRunId,
      category: input.category,
      output: input.output,
      entryIndex: input.entryIndex,
    });
  });
  if (!outcome.ok) {
    const code =
      isDashboardError(outcome.error) && OWN_CODES.has(outcome.error.code)
        ? outcome.error.code
        : noticeCodeFor(outcome.error);
    redirect(withNotice(back, code));
  }
  if (outcome.value === null) redirect(withNotice('/login', 'session_expired'));
  redirect(`/cards/${outcome.value.id}`);
}
