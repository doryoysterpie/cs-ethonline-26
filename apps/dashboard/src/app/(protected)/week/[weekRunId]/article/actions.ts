'use server';

import { redirect } from 'next/navigation';

import {
  generateArticle,
  readArticleSources,
  saveArticleRevision,
} from '../../../../../server/dal/mutate.ts';
import { assertActionRequest, currentPrincipal } from '../../../../../server/dal/principal.ts';
import { readClosedObject } from '../../../../../server/input.ts';
import { attempt, noticeCodeFor, withNotice } from '../../../../page-support.ts';

function target(weekRunId: unknown, category: unknown): string {
  const week = typeof weekRunId === 'string' ? weekRunId : '';
  const query =
    typeof category === 'string' && category.length > 0
      ? `?category=${encodeURIComponent(category)}`
      : '';
  return `/week/${encodeURIComponent(week)}/article${query}`;
}

export async function readSourcesAction(form: FormData): Promise<void> {
  let weekRunId: unknown = null;
  let category: unknown = null;
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return 'session_expired';
    await assertActionRequest(principal, form);
    const input = readClosedObject(form, ['csrfToken', 'weekRunId', 'category']);
    weekRunId = input.weekRunId;
    category = input.category;
    await readArticleSources(runtime, principal, {
      weekRunId: input.weekRunId,
      category: input.category,
    });
    return 'sources_read';
  });
  redirect(
    withNotice(
      target(weekRunId, category),
      outcome.ok ? outcome.value : noticeCodeFor(outcome.error),
    ),
  );
}

export async function generateArticleAction(form: FormData): Promise<void> {
  let weekRunId: unknown = null;
  let category: unknown = null;
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return 'session_expired';
    await assertActionRequest(principal, form);
    const input = readClosedObject(form, ['csrfToken', 'weekRunId', 'category', 'readingId']);
    weekRunId = input.weekRunId;
    category = input.category;
    await generateArticle(runtime, principal, {
      weekRunId: input.weekRunId,
      category: input.category,
      readingId: input.readingId,
    });
    return 'article_generated';
  });
  redirect(
    withNotice(
      target(weekRunId, category),
      outcome.ok ? outcome.value : noticeCodeFor(outcome.error),
    ),
  );
}

export async function saveArticleAction(form: FormData): Promise<void> {
  let weekRunId: unknown = null;
  let category: unknown = null;
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
    await saveArticleRevision(runtime, principal, {
      weekRunId: input.weekRunId,
      category: input.category,
      expectedRevision: input.expectedRevision,
      markdown: input.markdown,
    });
    return 'edited';
  });
  redirect(
    withNotice(
      target(weekRunId, category),
      outcome.ok ? outcome.value : noticeCodeFor(outcome.error),
    ),
  );
}
