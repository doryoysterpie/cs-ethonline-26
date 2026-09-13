'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { otpPendingCookieAttributes } from '../../server/auth/cookie.ts';
import { assertSameOrigin } from '../../server/auth/csrf.ts';
import { OTP_LIFETIME_SECONDS } from '../../server/auth/otp.ts';
import { networkKey } from '../../server/http/network.ts';
import { readClosedObject } from '../../server/input.ts';
import { getRuntime } from '../../server/runtime.ts';
import { attempt } from '../page-support.ts';

/**
 * Requests a one-time code. The only server action that runs without a
 * session, so it carries no session-bound CSRF token; it is protected by the
 * same-origin check and by the request throttle. Every outcome — approved,
 * unapproved, malformed, even throttled through to the same fixed notice —
 * redirects to the same verification screen, so nothing about the response
 * ever says whether the email was approved.
 */
export async function requestCode(form: FormData): Promise<void> {
  const runtime = await getRuntime();
  const outcome = await attempt(async () => {
    const list = await headers();
    assertSameOrigin(list, list.get('host'));
    const input = readClosedObject(form, ['email']);
    const result = await runtime.sessions.requestOtp({
      email: input.email,
      networkKey: networkKey(list, runtime.config),
    });
    return result.ok ? result.challengeId : null;
  });
  if (!outcome.ok || outcome.value === null) redirect('/login?notice=sign_in_failed');
  const attributes = otpPendingCookieAttributes(runtime.config.environment, OTP_LIFETIME_SECONDS);
  (await cookies()).set(attributes.name, outcome.value, {
    httpOnly: attributes.httpOnly,
    secure: attributes.secure,
    sameSite: attributes.sameSite,
    path: attributes.path,
    maxAge: attributes.maxAge,
  });
  redirect('/login/verify?notice=code_sent');
}
