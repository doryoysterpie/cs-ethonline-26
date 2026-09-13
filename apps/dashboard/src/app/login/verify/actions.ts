'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  otpPendingCookieName,
  readCookie,
  sessionCookieAttributes,
  sessionCookieName,
} from '../../../server/auth/cookie.ts';
import { assertSameOrigin } from '../../../server/auth/csrf.ts';
import { SESSION_ABSOLUTE_SECONDS } from '../../../server/auth/session.ts';
import { networkKey } from '../../../server/http/network.ts';
import { readClosedObject } from '../../../server/input.ts';
import { getRuntime } from '../../../server/runtime.ts';
import { attempt } from '../../page-support.ts';

/**
 * Verifies a one-time code. Same protections as `requestCode`: no session
 * exists yet, so no CSRF token, only the same-origin check and the verify
 * throttle. The pending-verification cookie, never the email or the code, is
 * what names which challenge this checks against.
 */
export async function verifyCode(form: FormData): Promise<void> {
  const runtime = await getRuntime();
  const outcome = await attempt(async () => {
    const list = await headers();
    assertSameOrigin(list, list.get('host'));
    const input = readClosedObject(form, ['code']);
    const pendingChallengeId = readCookie(
      list.get('cookie'),
      otpPendingCookieName(runtime.config.environment),
    );
    const presented = readCookie(list.get('cookie'), sessionCookieName(runtime.config.environment));
    return runtime.sessions.verifyOtp({
      challengeId: pendingChallengeId,
      code: input.code,
      networkKey: networkKey(list, runtime.config),
      presentedToken: presented,
    });
  });
  if (!outcome.ok || !outcome.value.ok) {
    redirect('/login/verify?notice=code_invalid');
  }
  const attributes = sessionCookieAttributes(runtime.config.environment, SESSION_ABSOLUTE_SECONDS);
  const jar = await cookies();
  jar.set(attributes.name, outcome.value.principal.sessionToken, {
    httpOnly: attributes.httpOnly,
    secure: attributes.secure,
    sameSite: attributes.sameSite,
    path: attributes.path,
    maxAge: attributes.maxAge,
  });
  jar.set(otpPendingCookieName(runtime.config.environment), '', { maxAge: 0, path: '/' });
  redirect('/command-center');
}
