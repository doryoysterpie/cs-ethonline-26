'use server';

import { redirect } from 'next/navigation';

import { assertActionRequest, currentPrincipal } from '../../../../server/dal/principal.ts';
import { publishOutput, unpublishOutput } from '../../../../server/dal/readers.ts';
import { readClosedObject } from '../../../../server/input.ts';
import { attempt, noticeCodeFor, withNotice } from '../../../page-support.ts';

function target(weekRunId: unknown, category: unknown, output: unknown): string {
  const week = typeof weekRunId === 'string' ? weekRunId : '';
  const page = output === 'article' ? 'article' : 'roundup';
  const query =
    typeof category === 'string' && category.length > 0
      ? `?category=${encodeURIComponent(category)}`
      : '';
  return `/week/${encodeURIComponent(week)}/${page}${query}`;
}

/** The owner marks one revision published (D42). */
export async function publishAction(form: FormData): Promise<void> {
  let weekRunId: unknown = null;
  let category: unknown = null;
  let output: unknown = null;
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return 'session_expired';
    await assertActionRequest(principal, form);
    const input = readClosedObject(form, [
      'csrfToken',
      'weekRunId',
      'category',
      'output',
      'revision',
    ]);
    weekRunId = input.weekRunId;
    category = input.category;
    output = input.output;
    await publishOutput(runtime, principal, {
      weekRunId: input.weekRunId,
      category: input.category,
      output: input.output,
      revision: input.revision,
    });
    return 'published';
  });
  redirect(
    withNotice(
      target(weekRunId, category, output),
      outcome.ok ? outcome.value : noticeCodeFor(outcome.error),
    ),
  );
}

/** The owner takes the output off the public pages; effective at once. */
export async function unpublishAction(form: FormData): Promise<void> {
  let weekRunId: unknown = null;
  let category: unknown = null;
  let output: unknown = null;
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return 'session_expired';
    await assertActionRequest(principal, form);
    const input = readClosedObject(form, ['csrfToken', 'weekRunId', 'category', 'output']);
    weekRunId = input.weekRunId;
    category = input.category;
    output = input.output;
    await unpublishOutput(runtime, principal, {
      weekRunId: input.weekRunId,
      category: input.category,
      output: input.output,
    });
    return 'unpublished';
  });
  redirect(
    withNotice(
      target(weekRunId, category, output),
      outcome.ok ? outcome.value : noticeCodeFor(outcome.error),
    ),
  );
}
