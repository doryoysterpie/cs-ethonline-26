'use server';

import { redirect } from 'next/navigation';

import { reviewQueueEntry } from '../../../../server/dal/mutate.ts';
import { assertActionRequest, currentPrincipal } from '../../../../server/dal/principal.ts';
import { readClosedObject } from '../../../../server/input.ts';
import { attempt, noticeCodeFor, withNotice } from '../../../page-support.ts';

export async function reviewAction(form: FormData): Promise<void> {
  let runId: unknown = null;
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return 'session_expired';
    await assertActionRequest(principal, form);
    const input = readClosedObject(form, [
      'csrfToken',
      'classificationRunId',
      'sourceRowId',
      'reviewState',
      'reasonCode',
      'note',
    ]);
    runId = input.classificationRunId;
    await reviewQueueEntry(runtime, principal, {
      classificationRunId: input.classificationRunId,
      sourceRowId: input.sourceRowId,
      reviewState: input.reviewState,
      reasonCode: input.reasonCode,
      note: input.note,
    });
    return 'recorded';
  });
  const run = typeof runId === 'string' ? runId : '';
  redirect(
    withNotice(
      `/queue/${encodeURIComponent(run)}`,
      outcome.ok ? outcome.value : noticeCodeFor(outcome.error),
    ),
  );
}
