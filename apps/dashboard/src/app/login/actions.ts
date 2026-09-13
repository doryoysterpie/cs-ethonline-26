'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  readCookie,
  sessionCookieAttributes,
  sessionCookieName,
} from '../../server/auth/cookie.ts';
import { assertSameOrigin } from '../../server/auth/csrf.ts';
import { SESSION_ABSOLUTE_SECONDS } from '../../server/auth/session.ts';
import { networkKey } from '../../server/http/network.ts';
import { readClosedObject } from '../../server/input.ts';
import { getRuntime } from '../../server/runtime.ts';
import { attempt } from '../page-support.ts';

/**
 * Sign-in. The only server action that runs without a session, so it carries
 * no session-bound CSRF token; it is protected by the same-origin check
 * (Next's own, then ours), by the throttle and by the verifier gate. Every
 * failure redirects to the same notice.
 */
export async function signIn(form: FormData): Promise<void> {
  const outcome = await attempt(async () => {
    const runtime = await getRuntime();
    const list = await headers();
    assertSameOrigin(list, list.get('host'));
    const input = readClosedObject(form, ['username', 'password']);
    const presented = readCookie(list.get('cookie'), sessionCookieName(runtime.config.environment));
    const result = await runtime.sessions.login({
      username: input.username,
      password: input.password,
      networkKey: networkKey(list, runtime.config),
      presentedToken: presented,
    });
    if (!result.ok) return false;
    const attributes = sessionCookieAttributes(
      runtime.config.environment,
      SESSION_ABSOLUTE_SECONDS,
    );
    (await cookies()).set(attributes.name, result.principal.sessionToken, {
      httpOnly: attributes.httpOnly,
      secure: attributes.secure,
      sameSite: attributes.sameSite,
      path: attributes.path,
      maxAge: attributes.maxAge,
    });
    return true;
  });
  if (outcome.ok && outcome.value) redirect('/command-center');
  redirect('/login?notice=sign_in_failed');
}
