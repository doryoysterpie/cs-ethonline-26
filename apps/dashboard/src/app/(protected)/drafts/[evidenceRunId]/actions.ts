'use server';

import { redirect } from 'next/navigation';

import { saveDraftRevision } from '../../../../server/dal/mutate.ts';
import { assertActionRequest, currentPrincipal } from '../../../../server/dal/principal.ts';
import { readClosedObject } from '../../../../server/input.ts';
import { attempt, noticeCodeFor, refusedCharacters, withNotice } from '../../../page-support.ts';
import type { NoticeCharacter } from '../../../notices.ts';

export async function saveDraftAction(form: FormData): Promise<void> {
  let runId: unknown = null;
  let start: unknown = null;
  let end: unknown = null;
  let removed: readonly NoticeCharacter[] = [];
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return 'session_expired';
    await assertActionRequest(principal, form);
    const input = readClosedObject(form, [
      'csrfToken',
      'evidenceRunId',
      'periodStart',
      'periodEnd',
      'expectedRevision',
      'markdown',
    ]);
    runId = input.evidenceRunId;
    start = input.periodStart;
    end = input.periodEnd;
    const saved = await saveDraftRevision(runtime, principal, {
      evidenceRunId: input.evidenceRunId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      expectedRevision: input.expectedRevision,
      markdown: input.markdown,
    });
    removed = saved.removed;
    return saved.removed.length > 0 ? 'saved_cleaned' : 'saved';
  });
  const run = typeof runId === 'string' ? runId : '';
  const query = new URLSearchParams({
    start: typeof start === 'string' ? start : '',
    end: typeof end === 'string' ? end : '',
  });
  redirect(
    withNotice(
      `/drafts/${encodeURIComponent(run)}?${query.toString()}`,
      outcome.ok ? outcome.value : noticeCodeFor(outcome.error),
      outcome.ok ? removed : refusedCharacters(outcome.error),
    ),
  );
}
