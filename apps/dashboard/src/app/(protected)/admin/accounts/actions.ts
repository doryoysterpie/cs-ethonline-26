'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { sessionCookieAttributes } from '../../../../server/auth/cookie.ts';
import { SESSION_ABSOLUTE_SECONDS } from '../../../../server/auth/session.ts';
import {
  assignRole,
  disableAccount,
  provisionAccount,
  revokeAccountSessions,
  setAccountExpiry,
} from '../../../../server/dal/mutate.ts';
import { assertActionRequest, currentPrincipal } from '../../../../server/dal/principal.ts';
import { validation } from '../../../../server/errors.ts';
import { readClosedObject } from '../../../../server/input.ts';
import { attempt, noticeCodeFor, withNotice } from '../../../page-support.ts';

const PAGE = '/admin/accounts';

async function guarded(
  form: FormData,
  work: (input: {
    runtime: Awaited<ReturnType<typeof currentPrincipal>>['runtime'];
    principal: NonNullable<Awaited<ReturnType<typeof currentPrincipal>>['principal']>;
  }) => Promise<string>,
): Promise<never> {
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return 'session_expired';
    await assertActionRequest(principal, form);
    return work({ runtime, principal });
  });
  redirect(withNotice(PAGE, outcome.ok ? outcome.value : noticeCodeFor(outcome.error)));
}

export async function provisionAction(form: FormData): Promise<void> {
  await guarded(form, async ({ runtime, principal }) => {
    const input = readClosedObject(form, [
      'csrfToken',
      'username',
      'role',
      'expiresAt',
      'password',
      'passwordAgain',
      'rotate',
    ]);
    if (input.password !== input.passwordAgain) {
      throw validation('password_mismatch', 'The two passwords differ.');
    }
    const result = await provisionAccount(runtime, principal, {
      username: input.username,
      role: input.role,
      expiresAt: input.expiresAt,
      password: input.password,
      rotate: input.rotate === 'yes',
    });
    return result.outcome === 'created' ? 'provisioned' : 'rotated';
  });
}

export async function disableAction(form: FormData): Promise<void> {
  await guarded(form, async ({ runtime, principal }) => {
    const input = readClosedObject(form, ['csrfToken', 'accountId']);
    await disableAccount(runtime, principal, input.accountId);
    return 'disabled';
  });
}

export async function assignRoleAction(form: FormData): Promise<void> {
  await guarded(form, async ({ runtime, principal }) => {
    const input = readClosedObject(form, ['csrfToken', 'accountId', 'role', 'expiresAt']);
    await assignRole(runtime, principal, {
      accountId: input.accountId,
      role: input.role,
      expiresAt: input.expiresAt,
    });
    return 'role_assigned';
  });
}

export async function setExpiryAction(form: FormData): Promise<void> {
  await guarded(form, async ({ runtime, principal }) => {
    const input = readClosedObject(form, ['csrfToken', 'accountId', 'expiresAt']);
    await setAccountExpiry(runtime, principal, input.accountId, input.expiresAt);
    return 'expiry_set';
  });
}

export async function revokeSessionsAction(form: FormData): Promise<void> {
  await guarded(form, async ({ runtime, principal }) => {
    const input = readClosedObject(form, ['csrfToken', 'accountId']);
    await revokeAccountSessions(runtime, principal, input.accountId);
    // Revoking one's own other sessions keeps this one; a rotation of this
    // session would be a privilege change, which this is not.
    if (input.accountId === principal.accountId) {
      const attributes = sessionCookieAttributes(
        runtime.config.environment,
        SESSION_ABSOLUTE_SECONDS,
      );
      (await cookies()).set(attributes.name, principal.sessionToken, {
        httpOnly: attributes.httpOnly,
        secure: attributes.secure,
        sameSite: attributes.sameSite,
        path: attributes.path,
        maxAge: attributes.maxAge,
      });
    }
    return 'revoked';
  });
}
