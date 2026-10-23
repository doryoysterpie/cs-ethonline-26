'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { assertActionRequest, currentPrincipal } from '../../../server/dal/principal.ts';
import { openBillingPortal, startCheckout } from '../../../server/dal/support.ts';
import { isDashboardError } from '../../../server/errors.ts';
import { networkKey } from '../../../server/http/network.ts';
import { readClosedObject } from '../../../server/input.ts';
import { attempt, noticeCodeFor, withNotice } from '../../page-support.ts';

const OWN_CODES = new Set(['support_not_configured', 'checkout_unavailable', 'checkout_limited']);

function failureNotice(error: unknown): string {
  if (isDashboardError(error) && OWN_CODES.has(error.code)) return error.code;
  if (isDashboardError(error) && error.code === 'no_supporter_record') return 'no_supporter_record';
  return noticeCodeFor(error);
}

/** The reader is sent to Stripe's hosted Checkout, or back here with a fixed notice. */
export async function startCheckoutAction(form: FormData): Promise<void> {
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return null;
    await assertActionRequest(principal, form);
    readClosedObject(form, ['csrfToken']);
    const list = await headers();
    return startCheckout(runtime, principal, { networkKey: networkKey(list, runtime.config) });
  });
  if (!outcome.ok) redirect(withNotice('/support', failureNotice(outcome.error)));
  if (outcome.value === null) redirect(withNotice('/support', 'session_expired'));
  redirect(outcome.value.url);
}

/** The supporter is sent to Stripe's hosted billing portal to manage the subscription. */
export async function openBillingPortalAction(form: FormData): Promise<void> {
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return null;
    await assertActionRequest(principal, form);
    readClosedObject(form, ['csrfToken']);
    const list = await headers();
    return openBillingPortal(runtime, principal, { networkKey: networkKey(list, runtime.config) });
  });
  if (!outcome.ok) redirect(withNotice('/support', failureNotice(outcome.error)));
  if (outcome.value === null) redirect(withNotice('/support', 'session_expired'));
  redirect(outcome.value.url);
}
