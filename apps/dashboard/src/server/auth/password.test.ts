import { describe, expect, it } from 'vitest';

import {
  ARGON2_PARAMETERS,
  VerificationGate,
  assertPassword,
  dummyHash,
  hashPassword,
  isVerifiableHash,
  validatePassword,
  verifyPassword,
} from './password.ts';

const SAMPLE = 'synthetic-only-Passphrase-42';

describe('password policy', () => {
  it('accepts a compliant password and normalises it with NFKC', () => {
    const result = validatePassword('ﬁne-synthetic-passphrase', 'syn_user');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.normalized).toBe('fine-synthetic-passphrase');
  });

  it('refuses short, long, control-bearing and username-bearing passwords with fixed codes', () => {
    expect(validatePassword('short', 'syn_user')).toEqual({
      ok: false,
      reason: 'password_too_short',
    });
    expect(validatePassword('x'.repeat(129), 'syn_user')).toEqual({
      ok: false,
      reason: 'password_too_long',
    });
    expect(validatePassword(`long-enough-${String.fromCodePoint(0x1b)}x`, 'syn_user')).toEqual({
      ok: false,
      reason: 'password_control_character',
    });
    expect(validatePassword('contains-SYN_USER-inside', 'syn_user')).toEqual({
      ok: false,
      reason: 'password_contains_username',
    });
    expect(() => assertPassword('short', 'syn_user')).toThrowError(/at least 12 characters/u);
  });

  it('counts code points, not UTF-16 units', () => {
    const twelveAstral = '𝔘'.repeat(12);
    expect(validatePassword(twelveAstral, 'syn_user').ok).toBe(true);
    expect(validatePassword('𝔘'.repeat(11), 'syn_user').ok).toBe(false);
  });
});

describe('argon2id hashing', () => {
  it('produces an argon2id PHC string at the OWASP minimum with a fresh salt each time', async () => {
    const first = await hashPassword(SAMPLE);
    const second = await hashPassword(SAMPLE);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/u);
    expect(first).not.toBe(second);
    expect(ARGON2_PARAMETERS.memoryCost).toBe(19456);
    expect(ARGON2_PARAMETERS.timeCost).toBe(2);
    expect(ARGON2_PARAMETERS.parallelism).toBe(1);
    expect(await verifyPassword(first, SAMPLE)).toBe(true);
    expect(await verifyPassword(second, SAMPLE)).toBe(true);
    expect(await verifyPassword(first, `${SAMPLE}!`)).toBe(false);
  });

  it('verifies the NFKC form, so a decomposed entry matches a composed hash', async () => {
    const composed = 'café-synthetic-passphrase';
    const decomposed = 'café-synthetic-passphrase';
    const stored = await hashPassword(composed.normalize('NFKC'));
    expect(await verifyPassword(stored, decomposed)).toBe(true);
  });

  it('refuses to verify a hash whose parameters exceed the ceiling or whose shape is wrong', async () => {
    const stored = await hashPassword(SAMPLE);
    const inflated = stored.replace('m=19456', 'm=1048576');
    expect(isVerifiableHash(stored)).toBe(true);
    expect(isVerifiableHash(inflated)).toBe(false);
    expect(await verifyPassword(inflated, SAMPLE)).toBe(false);
    expect(isVerifiableHash(stored.replace('argon2id', 'argon2i'))).toBe(false);
    expect(isVerifiableHash('not a hash')).toBe(false);
    expect(await verifyPassword('not a hash', SAMPLE)).toBe(false);
    expect(isVerifiableHash(stored.replace('t=2', 't=5'))).toBe(false);
    expect(isVerifiableHash(stored.replace('m=19456,p=1,t=2', 't=2,m=19456,p=1'))).toBe(true);
    expect(isVerifiableHash(stored.replace('m=19456,p=1,t=2', 'm=19456,m=19456,t=2'))).toBe(false);
    expect(isVerifiableHash(stored.replace('p=1', 'p=3'))).toBe(false);
  });

  it('keeps one dummy hash per process for unknown usernames', async () => {
    const first = await dummyHash();
    const second = await dummyHash();
    expect(first).toBe(second);
    expect(isVerifiableHash(first)).toBe(true);
  });
});

describe('verification gate', () => {
  it('runs up to the concurrency limit, queues up to the waiting limit, and refuses beyond it', async () => {
    const gate = new VerificationGate(1, 1);
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = gate.run(async () => {
      await blocked;
      return 'first';
    });
    const queued = gate.run(async () => 'second');
    const refused = await gate.run(async () => 'third');
    expect(refused).toEqual({ ok: false, reason: 'busy' });
    expect(gate.pending).toBe(2);
    release();
    expect(await running).toEqual({ ok: true, value: 'first' });
    expect(await queued).toEqual({ ok: true, value: 'second' });
    expect(gate.pending).toBe(0);
  });

  it('releases the slot when the work throws', async () => {
    const gate = new VerificationGate(1, 0);
    await expect(
      gate.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrowError('boom');
    expect(await gate.run(async () => 'ok')).toEqual({ ok: true, value: 'ok' });
  });
});
