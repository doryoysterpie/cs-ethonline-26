'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { readCookie, signupPendingCookieName } from '../../../server/auth/cookie.ts';
import { assertSameOrigin } from '../../../server/auth/csrf.ts';
import { verifySignup } from '../../../server/dal/readers.ts';
import { networkKey } from '../../../server/http/network.ts';
import { readClosedObject } from '../../../server/input.ts';
import { getRuntime } from '../../../server/runtime.ts';
import { attempt } from '../../page-support.ts';

/** The code step of sign-up: the pending cookie names the request, never the address. */
export async function verifySignupAction(form: FormData): Promise<void> {
  const runtime = await getRuntime();
  const outcome = await attempt(async () => {
    const list = await headers();
    assertSameOrigin(list, list.get('host'));
    const input = readClosedObject(form, ['code']);
    const requestId = readCookie(
      list.get('cookie'),
      signupPendingCookieName(runtime.config.environment),
    );
    return verifySignup(runtime, {
      requestId,
      code: input.code,
      networkKey: networkKey(list, runtime.config),
    });
  });
  const result = outcome.ok ? outcome.value : 'invalid';
  if (result === 'verified') {
    (await cookies()).set(signupPendingCookieName(runtime.config.environment), '', {
      maxAge: 0,
      path: '/',
    });
    redirect('/signup/verify?notice=signup_recorded');
  }
  if (result === 'locked') redirect('/signup/verify?notice=signup_locked');
  if (result === 'expired') redirect('/signup?notice=signup_expired');
  redirect('/signup/verify?notice=signup_code_invalid');
}
