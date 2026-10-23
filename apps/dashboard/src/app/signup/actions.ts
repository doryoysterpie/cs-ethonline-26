'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { signupPendingCookieAttributes } from '../../server/auth/cookie.ts';
import { assertSameOrigin } from '../../server/auth/csrf.ts';
import { OTP_LIFETIME_SECONDS } from '../../server/auth/otp.ts';
import { requestSignup } from '../../server/dal/readers.ts';
import { networkKey } from '../../server/http/network.ts';
import { readClosedObject } from '../../server/input.ts';
import { getRuntime } from '../../server/runtime.ts';
import { attempt } from '../page-support.ts';

/**
 * The address step of sign-up (CAS-007). No session exists, so no CSRF
 * token: the same-origin check and the limits protect it. Every outcome
 * redirects to the same verification screen with the same notice, so nothing
 * about the response says whether the address is known, pending or new.
 */
export async function requestSignupAction(form: FormData): Promise<void> {
  const runtime = await getRuntime();
  const outcome = await attempt(async () => {
    const list = await headers();
    assertSameOrigin(list, list.get('host'));
    const input = readClosedObject(form, ['email']);
    return requestSignup(runtime, {
      email: input.email,
      networkKey: networkKey(list, runtime.config),
    });
  });
  if (!outcome.ok) redirect('/signup?notice=failed');
  const attributes = signupPendingCookieAttributes(
    runtime.config.environment,
    OTP_LIFETIME_SECONDS,
  );
  (await cookies()).set(attributes.name, outcome.value.requestId, {
    httpOnly: attributes.httpOnly,
    secure: attributes.secure,
    sameSite: attributes.sameSite,
    path: attributes.path,
    maxAge: attributes.maxAge,
  });
  redirect('/signup/verify?notice=signup_code_sent');
}
