'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { sessionCookieName } from '../../server/auth/cookie.ts';
import { assertActionRequest, currentPrincipal } from '../../server/dal/principal.ts';
import { attempt } from '../page-support.ts';

/** Sign-out: revokes the session and clears the cookie. */
export async function signOut(form: FormData): Promise<void> {
  await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return;
    await assertActionRequest(principal, form);
    await runtime.sessions.logout(principal);
    (await cookies()).delete(sessionCookieName(runtime.config.environment));
  });
  redirect('/login?notice=signed_out');
}
