'use server';

import { redirect } from 'next/navigation';

import { selectStory } from '../../../../server/dal/mutate.ts';
import { assertActionRequest, currentPrincipal } from '../../../../server/dal/principal.ts';
import { readClosedObject } from '../../../../server/input.ts';
import {
  attempt,
  noticeCodeFor,
  NO_REFUSAL,
  refusalOf,
  withNotice,
} from '../../../page-support.ts';

export async function selectAction(form: FormData): Promise<void> {
  let weekRunId: unknown = null;
  let category: unknown = null;
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return 'session_expired';
    await assertActionRequest(principal, form);
    const input = readClosedObject(form, [
      'csrfToken',
      'weekRunId',
      'clusteringRunId',
      'incidentId',
      'category',
      'state',
      'note',
    ]);
    weekRunId = input.weekRunId;
    category = input.category;
    await selectStory(runtime, principal, {
      weekRunId: input.weekRunId,
      clusteringRunId: input.clusteringRunId,
      incidentId: input.incidentId,
      state: input.state,
      note: input.note,
    });
    return typeof input.state === 'string' ? input.state : 'recorded';
  });
  const week = typeof weekRunId === 'string' ? weekRunId : '';
  const query =
    typeof category === 'string' && category.length > 0
      ? `?category=${encodeURIComponent(category)}`
      : '';
  redirect(
    withNotice(
      `/week/${encodeURIComponent(week)}${query}`,
      outcome.ok ? outcome.value : noticeCodeFor(outcome.error),
      outcome.ok ? NO_REFUSAL : refusalOf(outcome.error),
    ),
  );
}
