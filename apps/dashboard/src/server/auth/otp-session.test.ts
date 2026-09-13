import { describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';

import type { EmailMessage, EmailProvider } from './email-provider.ts';
import { openMemoryStores } from './memory-store.ts';
import { SessionService } from './session.ts';
import type { AccountRecord } from './store.ts';

/**
 * Focused coverage of the passwordless flow: enough to prove the generic
 * response, the correct/wrong/expired/replayed code paths and the
 * unapproved-email non-disclosure all work, against the in-memory store.
 */

function fakeProvider(): EmailProvider & { readonly sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

async function serviceWithApprovedAdmin(now: () => Date) {
  const stores = await openMemoryStores(null);
  const email = 'info.ma37abi@gmail.com';
  const record: AccountRecord = {
    id: randomUUID(),
    username: null,
    role: 'admin',
    passwordHash: null,
    createdAt: now().toISOString(),
    passwordChangedAt: now().toISOString(),
    disabledAt: null,
    expiresAt: null,
    normalizedEmail: email,
  };
  await stores.accounts.insert(record);
  const provider = fakeProvider();
  const sessions = new SessionService(stores, {
    now,
    emailProvider: provider,
    otpPepper: 'a'.repeat(32),
  });
  return { sessions, provider, email };
}

describe('passwordless email sign-in', () => {
  it('returns the same outcome shape for an approved and an unapproved email, and only sends mail for the approved one', async () => {
    const { sessions, provider, email } = await serviceWithApprovedAdmin(() => new Date());
    const approved = await sessions.requestOtp({ email, networkKey: 'net' });
    const unapproved = await sessions.requestOtp({
      email: 'nobody@example.com',
      networkKey: 'net',
    });
    expect(approved.ok).toBe(true);
    expect(unapproved.ok).toBe(true);
    if (approved.ok) expect(approved.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    if (unapproved.ok) expect(unapproved.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.to).toBe(email);
  });

  it('verifies the correct code once, then refuses replay of the same code', async () => {
    const { sessions, provider, email } = await serviceWithApprovedAdmin(() => new Date());
    const requested = await sessions.requestOtp({ email, networkKey: 'net' });
    if (!requested.ok) throw new Error('unreachable');
    const code = provider.sent[0]?.text.match(/\d{6}/)?.[0];
    if (code === undefined) throw new Error('no code found in the sent message');

    const first = await sessions.verifyOtp({
      challengeId: requested.challengeId,
      code,
      networkKey: 'net',
      presentedToken: null,
    });
    expect(first.ok).toBe(true);

    const replay = await sessions.verifyOtp({
      challengeId: requested.challengeId,
      code,
      networkKey: 'net',
      presentedToken: null,
    });
    expect(replay).toEqual({ ok: false, status: 401 });
  });

  it('refuses a wrong code and an unknown challenge id, without throwing', async () => {
    const { sessions, email } = await serviceWithApprovedAdmin(() => new Date());
    const requested = await sessions.requestOtp({ email, networkKey: 'net' });
    if (!requested.ok) throw new Error('unreachable');

    const wrong = await sessions.verifyOtp({
      challengeId: requested.challengeId,
      code: '000000',
      networkKey: 'net',
      presentedToken: null,
    });
    expect(wrong).toEqual({ ok: false, status: 401 });

    const unknown = await sessions.verifyOtp({
      challengeId: '00000000-0000-0000-0000-000000000000',
      code: '000000',
      networkKey: 'net',
      presentedToken: null,
    });
    expect(unknown).toEqual({ ok: false, status: 401 });
  });

  it('refuses a code once it has expired', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const { sessions, provider, email } = await serviceWithApprovedAdmin(() => now);
    const requested = await sessions.requestOtp({ email, networkKey: 'net' });
    if (!requested.ok) throw new Error('unreachable');
    const code = provider.sent[0]?.text.match(/\d{6}/)?.[0];
    if (code === undefined) throw new Error('no code found in the sent message');

    now = new Date(now.getTime() + 11 * 60 * 1000);
    const expired = await sessions.verifyOtp({
      challengeId: requested.challengeId,
      code,
      networkKey: 'net',
      presentedToken: null,
    });
    expect(expired).toEqual({ ok: false, status: 401 });
  });

  it('fails closed when the email provider and pepper are not configured', async () => {
    const stores = await openMemoryStores(null);
    const sessions = new SessionService(stores);
    await expect(
      sessions.requestOtp({ email: 'x@example.com', networkKey: 'net' }),
    ).rejects.toMatchObject({
      code: 'otp_email_not_configured',
    });
  });
});
