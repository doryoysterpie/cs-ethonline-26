import 'server-only';

import { randomBytes } from 'node:crypto';

import argon2 from 'argon2';

import { validation } from '../errors.ts';

/**
 * Password policy and hashing.
 *
 * Hashing is Argon2id through the maintained `argon2` binding of the reference
 * implementation, at the OWASP Password Storage Cheat Sheet's recommended
 * minimum for Argon2id: 19 MiB of memory, 2 iterations, 1 degree of
 * parallelism. The library draws a fresh 16-byte salt from the CSPRNG for
 * every hash and encodes salt and parameters into the PHC string it returns,
 * so no salt is chosen, stored or reused by this code.
 *
 * Work is bounded in two ways. First, a stored hash is verified only if its
 * parameters fall inside a fixed ceiling, so a hash injected into a store
 * cannot make a login cost gigabytes. Second, `VerificationGate` limits how
 * many verifications run at once and how many may wait, so a burst of logins
 * cannot pin every core; a caller that finds the gate full gets `busy` and
 * answers with the same generic failure as any other refusal.
 *
 * Passwords are normalised with NFKC before hashing and before verification
 * (NIST SP 800-63B section 5.1.1.2), so a password typed on two keyboards
 * that compose the same characters differently still matches.
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const ARGON2_PARAMETERS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

/** The most expensive stored hash this code will verify. */
export const ARGON2_CEILING = { memoryCost: 65536, timeCost: 4, parallelism: 2 } as const;

const char = (code: number): string => String.fromCodePoint(code);
const CONTROL = new RegExp(
  `[${char(0x00)}-${char(0x1f)}${char(0x7f)}-${char(0x9f)}${char(0x2028)}${char(0x2029)}]`,
  'u',
);

export type PasswordRejection =
  | 'password_too_short'
  | 'password_too_long'
  | 'password_control_character'
  | 'password_contains_username';

/**
 * Validates and normalises a candidate password. The rejection names only a
 * fixed code; the message never carries the candidate.
 */
export function validatePassword(
  raw: string,
  username: string,
):
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly reason: PasswordRejection } {
  const normalized = raw.normalize('NFKC');
  const length = [...normalized].length;
  if (length < PASSWORD_MIN_LENGTH) return { ok: false, reason: 'password_too_short' };
  if (length > PASSWORD_MAX_LENGTH) return { ok: false, reason: 'password_too_long' };
  if (CONTROL.test(normalized)) return { ok: false, reason: 'password_control_character' };
  if (username.length >= 3 && normalized.toLowerCase().includes(username.toLowerCase())) {
    return { ok: false, reason: 'password_contains_username' };
  }
  return { ok: true, normalized };
}

export function assertPassword(raw: string, username: string): string {
  const result = validatePassword(raw, username);
  if (!result.ok) {
    throw validation(
      result.reason,
      result.reason === 'password_too_short'
        ? `the password must be at least ${PASSWORD_MIN_LENGTH} characters`
        : result.reason === 'password_too_long'
          ? `the password must be at most ${PASSWORD_MAX_LENGTH} characters`
          : result.reason === 'password_control_character'
            ? 'the password must not contain a control character'
            : 'the password must not contain the username',
    );
  }
  return result.normalized;
}

/** Hashes a validated, normalised password. A fresh random salt every call. */
export async function hashPassword(normalized: string): Promise<string> {
  // The library draws a fresh 16-byte salt from the CSPRNG when none is
  // supplied; none is supplied here, so no salt is ever chosen or reused.
  return argon2.hash(normalized, { ...ARGON2_PARAMETERS });
}

const PHC =
  /^\$argon2id\$v=19\$([a-z]=\d{1,7}(?:,[a-z]=\d{1,7}){2})\$[A-Za-z0-9+/]{16,}\$[A-Za-z0-9+/]{16,}$/u;

/**
 * True when the stored value is an Argon2id PHC string whose parameters are
 * within the ceiling. The library writes the three parameters in alphabetical
 * order (`m`, `p`, `t`); they are read by name so the order is irrelevant.
 * Anything else is never handed to the verifier.
 */
export function isVerifiableHash(stored: string): boolean {
  const match = PHC.exec(stored);
  if (match === null) return false;
  const parameters = new Map<string, number>();
  for (const pair of (match[1] ?? '').split(',')) {
    const [key, value] = pair.split('=');
    if (key === undefined || value === undefined || parameters.has(key)) return false;
    parameters.set(key, Number(value));
  }
  const memory = parameters.get('m');
  const time = parameters.get('t');
  const parallelism = parameters.get('p');
  if (memory === undefined || time === undefined || parallelism === undefined) return false;
  if (parameters.size !== 3) return false;
  return (
    memory >= 1024 &&
    memory <= ARGON2_CEILING.memoryCost &&
    time >= 1 &&
    time <= ARGON2_CEILING.timeCost &&
    parallelism >= 1 &&
    parallelism <= ARGON2_CEILING.parallelism
  );
}

/** Verifies a raw password against a stored hash. Never throws on a bad hash: that is `false`. */
export async function verifyPassword(stored: string, raw: string): Promise<boolean> {
  if (!isVerifiableHash(stored)) return false;
  try {
    return await argon2.verify(stored, raw.normalize('NFKC'));
  } catch {
    return false;
  }
}

let dummy: Promise<string> | null = null;

/**
 * A hash of a random value, computed once per process, verified whenever the
 * submitted username matches no account, so an unknown name costs the same
 * time as a wrong password.
 */
export function dummyHash(): Promise<string> {
  if (dummy === null) dummy = hashPassword(randomBytes(24).toString('base64url'));
  return dummy;
}

export type GateOutcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: 'busy' };

/** Bounds concurrent and queued verification work. */
export class VerificationGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly maxConcurrent: number = 4,
    private readonly maxWaiting: number = 16,
  ) {}

  get pending(): number {
    return this.active + this.waiting.length;
  }

  async run<T>(work: () => Promise<T>): Promise<GateOutcome<T>> {
    if (this.active >= this.maxConcurrent) {
      if (this.waiting.length >= this.maxWaiting) return { ok: false, reason: 'busy' };
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
    this.active += 1;
    try {
      return { ok: true, value: await work() };
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next !== undefined) next();
    }
  }
}
