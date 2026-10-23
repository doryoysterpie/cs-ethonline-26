'use server';

import { redirect } from 'next/navigation';

import { assertActionRequest, currentPrincipal } from '../../../../server/dal/principal.ts';
import { approveSignup, denySignup } from '../../../../server/dal/readers.ts';
import { readClosedObject } from '../../../../server/input.ts';
import { attempt, noticeCodeFor, withNotice } from '../../../page-support.ts';

const PAGE = '/admin/requests';

export async function approveAction(form: FormData): Promise<void> {
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return 'session_expired';
    await assertActionRequest(principal, form);
    const input = readClosedObject(form, ['csrfToken', 'requestId', 'expiresAt']);
    await approveSignup(runtime, principal, {
      requestId: input.requestId,
      expiresAt: input.expiresAt === '' ? null : input.expiresAt,
    });
    return 'approved';
  });
  redirect(withNotice(PAGE, outcome.ok ? outcome.value : noticeCodeFor(outcome.error)));
}

export async function denyAction(form: FormData): Promise<void> {
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return 'session_expired';
    await assertActionRequest(principal, form);
    const input = readClosedObject(form, ['csrfToken', 'requestId']);
    await denySignup(runtime, principal, { requestId: input.requestId });
    return 'denied';
  });
  redirect(withNotice(PAGE, outcome.ok ? outcome.value : noticeCodeFor(outcome.error)));
}
