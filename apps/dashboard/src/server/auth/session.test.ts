import { describe, expect, it } from 'vitest';

import { insertSynthetic, syntheticAccount } from '../../test/synthetic-accounts.ts';
import { openMemoryStores } from './memory-store.ts';
import { VerificationGate } from './password.ts';
import {
  SESSION_ABSOLUTE_SECONDS,
  SESSION_IDLE_SECONDS,
  SESSION_TOUCH_INTERVAL_SECONDS,
  SessionService,
} from './session.ts';
import { generateSessionToken, hashSessionToken } from './tokens.ts';

/**
 * The session service against the memory stores with an injected clock.
 * Every property the sprint brief names for sessions is pinned here.
 */

const START = Date.parse('2026-09-10T12:00:00.000Z');

async function harness(options: { gate?: VerificationGate } = {}) {
  const stores = await openMemoryStores(null);
  let now = START;
  const clock = {
    get: () => new Date(now),
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
  };
  const sessions = new SessionService(stores, { now: clock.get, gate: options.gate });
  const editor = await syntheticAccount('editor', { now: new Date(START) });
  const judge = await syntheticAccount('judge', {
    now: new Date(START),
    expiresAt: new Date(START + 3600 * 1000).toISOString(),
  });
  await insertSynthetic(stores, editor);
  await insertSynthetic(stores, judge);
  return { stores, sessions, clock, editor, judge };
}

describe('sign-in', () => {
  it('issues a fresh session and records a success event', async () => {
    const { stores, sessions, editor } = await harness();
    const result = await sessions.login({
      username: editor.record.username,
      password: editor.password,
      networkKey: 'direct',
      presentedToken: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.role).toBe('editor');
    expect(result.principal.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const stored = await stores.sessions.findByTokenHash(
      hashSessionToken(result.principal.sessionToken),
    );
    expect(stored?.accountId).toBe(editor.record.id);
    // The token itself is not stored anywhere.
    expect(JSON.stringify(stored)).not.toContain(result.principal.sessionToken);
    const events = await stores.audit.list(10);
    expect(events[0]?.kind).toBe('login_succeeded');
    expect(events[0]?.subjectAccountId).toBe(editor.record.id);
  });

  it('answers every failure the same way and never records an unknown username', async () => {
    const { stores, sessions, editor } = await harness();
    const unknown = await sessions.login({
      username: 'syn_nobody',
      password: 'irrelevant-synthetic-value',
      networkKey: 'direct',
      presentedToken: null,
    });
    const wrong = await sessions.login({
      username: editor.record.username,
      password: `${editor.password}x`,
      networkKey: 'direct',
      presentedToken: null,
    });
    const malformed = await sessions.login({
      username: 'Not A Username',
      password: 'irrelevant-synthetic-value',
      networkKey: 'direct',
      presentedToken: null,
    });
    const notString = await sessions.login({
      username: { toString: () => editor.record.username },
      password: editor.password,
      networkKey: 'direct',
      presentedToken: null,
    });
    expect(unknown).toEqual({ ok: false, status: 401 });
    expect(wrong).toEqual({ ok: false, status: 401 });
    expect(malformed).toEqual({ ok: false, status: 401 });
    expect(notString).toEqual({ ok: false, status: 401 });
    const events = await stores.audit.list(10);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('syn_nobody');
    expect(serialized).not.toContain('Not A Username');
    expect(serialized).not.toContain(editor.password);
    expect(events.filter((event) => event.kind === 'login_failed')).toHaveLength(4);
    expect(events.find((event) => event.code === 'no_such_account')?.subjectAccountId).toBeNull();
  });

  it('refuses a disabled account and an expired account with the same generic failure', async () => {
    const { stores, sessions, editor, judge, clock } = await harness();
    await stores.accounts.setDisabled(editor.record.id, clock.get().toISOString());
    const disabled = await sessions.login({
      username: editor.record.username,
      password: editor.password,
      networkKey: 'direct',
      presentedToken: null,
    });
    clock.advance(3601);
    const expired = await sessions.login({
      username: judge.record.username,
      password: judge.password,
      networkKey: 'direct',
      presentedToken: null,
    });
    expect(disabled).toEqual({ ok: false, status: 401 });
    expect(expired).toEqual({ ok: false, status: 401 });
  });

  it('throttles by account after repeated failures, existing or not, and by network source', async () => {
    const { sessions, editor, clock } = await harness();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await sessions.login({
        username: editor.record.username,
        password: 'wrong-synthetic-value',
        networkKey: 'direct',
        presentedToken: null,
      });
      await sessions.login({
        username: 'syn_ghost',
        password: 'wrong-synthetic-value',
        networkKey: 'direct',
        presentedToken: null,
      });
      clock.advance(1);
    }
    const existing = await sessions.login({
      username: editor.record.username,
      password: editor.password,
      networkKey: 'direct',
      presentedToken: null,
    });
    const ghost = await sessions.login({
      username: 'syn_ghost',
      password: 'wrong-synthetic-value',
      networkKey: 'direct',
      presentedToken: null,
    });
    expect(existing).toEqual({ ok: false, status: 429 });
    expect(ghost).toEqual({ ok: false, status: 429 });
    // A different network source is counted separately, but the account window still holds.
    const other = await sessions.login({
      username: editor.record.username,
      password: editor.password,
      networkKey: '203.0.113.5',
      presentedToken: null,
    });
    expect(other).toEqual({ ok: false, status: 429 });
  });

  it('answers with a generic retry status when the verifier is saturated', async () => {
    const gate = new VerificationGate(0, 0);
    const { sessions, editor } = await harness({ gate });
    const busy = await sessions.login({
      username: editor.record.username,
      password: editor.password,
      networkKey: 'direct',
      presentedToken: null,
    });
    expect(busy).toEqual({ ok: false, status: 429 });
  });

  it('never adopts a presented token and closes a presented live session', async () => {
    const { sessions, editor } = await harness();
    const fixation = generateSessionToken();
    const first = await sessions.login({
      username: editor.record.username,
      password: editor.password,
      networkKey: 'direct',
      presentedToken: fixation,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.principal.sessionToken).not.toBe(fixation);
    expect(await sessions.authenticate(fixation)).toBeNull();
    const second = await sessions.login({
      username: editor.record.username,
      password: editor.password,
      networkKey: 'direct',
      presentedToken: first.principal.sessionToken,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.principal.sessionToken).not.toBe(first.principal.sessionToken);
    expect(await sessions.authenticate(first.principal.sessionToken)).toBeNull();
    expect(await sessions.authenticate(second.principal.sessionToken)).not.toBeNull();
  });
});

describe('session validation', () => {
  async function signedIn() {
    const context = await harness();
    const result = await context.sessions.login({
      username: context.editor.record.username,
      password: context.editor.password,
      networkKey: 'direct',
      presentedToken: null,
    });
    if (!result.ok) throw new Error('sign-in failed in the harness');
    return { ...context, token: result.principal.sessionToken, principal: result.principal };
  }

  it('resolves a live token and rejects a malformed or unknown one', async () => {
    const { sessions, token } = await signedIn();
    expect((await sessions.authenticate(token))?.role).toBe('editor');
    expect(await sessions.authenticate(undefined)).toBeNull();
    expect(await sessions.authenticate('')).toBeNull();
    expect(await sessions.authenticate(generateSessionToken())).toBeNull();
    expect(await sessions.authenticate(hashSessionToken(token))).toBeNull();
  });

  it('ends a session at the idle limit and at the absolute limit', async () => {
    const idle = await signedIn();
    idle.clock.advance(SESSION_IDLE_SECONDS - 1);
    expect(await idle.sessions.authenticate(idle.token)).not.toBeNull();
    idle.clock.advance(SESSION_IDLE_SECONDS);
    expect(await idle.sessions.authenticate(idle.token)).toBeNull();

    const absolute = await signedIn();
    let elapsed = 0;
    while (elapsed + SESSION_TOUCH_INTERVAL_SECONDS * 2 < SESSION_ABSOLUTE_SECONDS) {
      absolute.clock.advance(SESSION_TOUCH_INTERVAL_SECONDS * 2);
      elapsed += SESSION_TOUCH_INTERVAL_SECONDS * 2;
      expect(await absolute.sessions.authenticate(absolute.token)).not.toBeNull();
    }
    absolute.clock.advance(SESSION_TOUCH_INTERVAL_SECONDS * 3);
    expect(await absolute.sessions.authenticate(absolute.token)).toBeNull();
    const events = await absolute.stores.audit.list(3);
    expect(events[0]?.kind).toBe('session_rejected');
    expect(events[0]?.code).toBe('absolute_expiry');
  });

  it('revokes on logout, so a replayed token is refused', async () => {
    const { sessions, token, principal } = await signedIn();
    await sessions.logout(principal);
    expect(await sessions.authenticate(token)).toBeNull();
  });

  it('revokes every session of an account, optionally keeping one', async () => {
    const context = await signedIn();
    const second = await context.sessions.login({
      username: context.editor.record.username,
      password: context.editor.password,
      networkKey: 'direct',
      presentedToken: null,
    });
    if (!second.ok) throw new Error('second sign-in failed');
    const kept = second.principal.sessionToken;
    const revoked = await context.sessions.revokeAllSessions(
      second.principal,
      context.editor.record.id,
      'test',
      second.principal.sessionId,
    );
    // The first session is still live, so exactly one is revoked and the kept one survives.
    expect(revoked).toBe(1);
    expect(await context.sessions.authenticate(context.token)).toBeNull();
    expect(await context.sessions.authenticate(kept)).not.toBeNull();
    await context.sessions.revokeAllSessions(null, context.editor.record.id, 'test', null);
    expect(await context.sessions.authenticate(kept)).toBeNull();
  });

  it('rotates a session on a privilege change: the old token dies, a new one lives', async () => {
    const { sessions, token, principal } = await signedIn();
    const rotated = await sessions.rotate(principal);
    expect(rotated.principal.sessionToken).not.toBe(token);
    expect(await sessions.authenticate(token)).toBeNull();
    expect(await sessions.authenticate(rotated.principal.sessionToken)).not.toBeNull();
  });

  it('ends a session when the account is disabled or a judge account expires', async () => {
    const context = await harness();
    const judge = await context.sessions.login({
      username: context.judge.record.username,
      password: context.judge.password,
      networkKey: 'direct',
      presentedToken: null,
    });
    if (!judge.ok) throw new Error('judge sign-in failed');
    expect(await context.sessions.authenticate(judge.principal.sessionToken)).not.toBeNull();
    context.clock.advance(3601);
    expect(await context.sessions.authenticate(judge.principal.sessionToken)).toBeNull();

    const editor = await context.sessions.login({
      username: context.editor.record.username,
      password: context.editor.password,
      networkKey: 'direct',
      presentedToken: null,
    });
    if (!editor.ok) throw new Error('editor sign-in failed');
    await context.stores.accounts.setDisabled(
      context.editor.record.id,
      context.clock.get().toISOString(),
    );
    expect(await context.sessions.authenticate(editor.principal.sessionToken)).toBeNull();
  });

  it('touches the session at most once per interval', async () => {
    const { sessions, stores, token, clock, principal } = await signedIn();
    const before = await stores.sessions.findByTokenHash(hashSessionToken(token));
    clock.advance(SESSION_TOUCH_INTERVAL_SECONDS - 5);
    await sessions.authenticate(token);
    const untouched = await stores.sessions.findByTokenHash(hashSessionToken(token));
    expect(untouched?.lastSeenAt).toBe(before?.lastSeenAt);
    clock.advance(10);
    await sessions.authenticate(token);
    const touched = await stores.sessions.findByTokenHash(hashSessionToken(token));
    expect(touched?.lastSeenAt).not.toBe(before?.lastSeenAt);
    expect(touched?.id).toBe(principal.sessionId);
  });
});
