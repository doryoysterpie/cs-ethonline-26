import { randomBytes, randomUUID } from 'node:crypto';

import { hashPassword } from '../server/auth/password.ts';
import type { Role } from '../server/auth/roles.ts';
import type { AccountRecord, Stores } from '../server/auth/store.ts';

/**
 * Synthetic accounts for tests. Usernames are prefixed `syn_` so they can
 * never be confused with a provisioned account, and every password is drawn
 * from the CSPRNG at test time, so no password exists anywhere but in the
 * memory of the test that made it.
 */
export interface SyntheticAccount {
  readonly record: AccountRecord;
  readonly password: string;
}

export function syntheticPassword(): string {
  return `S-${randomBytes(18).toString('base64url')}`;
}

export async function syntheticAccount(
  role: Role,
  options: {
    readonly username?: string | undefined;
    readonly expiresAt?: string | null | undefined;
    readonly disabledAt?: string | null | undefined;
    readonly now?: Date | undefined;
  } = {},
): Promise<SyntheticAccount> {
  const now = (options.now ?? new Date()).toISOString();
  const password = syntheticPassword();
  const expiresAt =
    options.expiresAt === undefined
      ? role === 'judge'
        ? new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
        : null
      : options.expiresAt;
  return {
    password,
    record: {
      id: randomUUID(),
      username: options.username ?? `syn_${role}_${randomBytes(3).toString('hex')}`,
      role,
      passwordHash: await hashPassword(password.normalize('NFKC')),
      createdAt: now,
      passwordChangedAt: now,
      disabledAt: options.disabledAt ?? null,
      expiresAt,
    },
  };
}

export async function insertSynthetic(stores: Stores, account: SyntheticAccount): Promise<void> {
  await stores.accounts.insert(account.record);
}
