'use server';

import { redirect } from 'next/navigation';

import { generateRoundup, saveRoundupRevision } from '../../../../../server/dal/mutate.ts';
import { assertActionRequest, currentPrincipal } from '../../../../../server/dal/principal.ts';
import { readClosedObject } from '../../../../../server/input.ts';
import {
  attempt,
  noticeCodeFor,
  NO_REFUSAL,
  refusalOf,
  withNotice,
} from '../../../../page-support.ts';

function target(weekRunId: unknown, category: unknown): string {
  const week = typeof weekRunId === 'string' ? weekRunId : '';
  const query =
    typeof category === 'string' && category.length > 0
      ? `?category=${encodeURIComponent(category)}`
      : '';
  return `/week/${encodeURIComponent(week)}/roundup${query}`;
}

export async function generateAction(form: FormData): Promise<void> {
  let weekRunId: unknown = null;
  let category: unknown = null;
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return 'session_expired';
    await assertActionRequest(principal, form);
    const input = readClosedObject(form, ['csrfToken', 'weekRunId', 'category', 'templateHash']);
    weekRunId = input.weekRunId;
    category = input.category;
    await generateRoundup(runtime, principal, {
      weekRunId: input.weekRunId,
      category: input.category,
      expectedTemplateHash: input.templateHash,
    });
    return 'generated';
  });
  redirect(
    withNotice(
      target(weekRunId, category),
      outcome.ok ? outcome.value : noticeCodeFor(outcome.error),
    ),
  );
}

export async function saveRoundupAction(form: FormData): Promise<void> {
  let weekRunId: unknown = null;
  let category: unknown = null;
  // A save that removed characters names its revision; the page lists the record it keeps.
  let cleanedRevision: number | null = null;
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return 'session_expired';
    await assertActionRequest(principal, form);
    const input = readClosedObject(form, [
      'csrfToken',
      'weekRunId',
      'category',
      'expectedRevision',
      'markdown',
    ]);
    weekRunId = input.weekRunId;
    category = input.category;
    const saved = await saveRoundupRevision(runtime, principal, {
      weekRunId: input.weekRunId,
      category: input.category,
      expectedRevision: input.expectedRevision,
      markdown: input.markdown,
    });
    if (saved.removed.length === 0) return 'edited';
    cleanedRevision = saved.revision;
    return 'edited_cleaned';
  });
  redirect(
    withNotice(
      target(weekRunId, category),
      outcome.ok ? outcome.value : noticeCodeFor(outcome.error),
      outcome.ok ? NO_REFUSAL : refusalOf(outcome.error),
      outcome.ok ? cleanedRevision : null,
    ),
  );
}
