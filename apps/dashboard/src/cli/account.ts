import { randomUUID } from 'node:crypto';
import { stdout, stderr } from 'node:process';

import type { Database } from '@cas/database';

import { inviteAccount } from '../server/dal/mutate.ts';
import { openStores } from '../server/auth/stores.ts';
import { loadDashboardConfig } from '../server/config.ts';
import { isDashboardError } from '../server/errors.ts';
import { workspace } from '../server/packages.ts';

/**
 * Administrator account operations with no secret to protect, so unlike
 * `provision.ts` this needs no TTY and no interactive entry.
 *
 *   corepack pnpm --filter @cas/dashboard account invite --email <email> --role <judge|editor|admin> [--expires-at <instant>]
 *   corepack pnpm --filter @cas/dashboard account disable --username <name>
 *
 * `disable` is the transition's containment step: it disables a
 * username/password account and revokes every live session of it, without
 * requiring the invitation flow's admin capability check, exactly as
 * `provision.ts` bypasses that check for its own one-time use.
 *
 * Exit codes: 0 success, 2 configuration or validation, 5 unexpected.
 */

interface Arguments {
  readonly email: string | null;
  readonly role: string | null;
  readonly expiresAt: string | null;
  readonly username: string | null;
}

function parseArguments(argv: readonly string[]): Arguments {
  let email: string | null = null;
  let role: string | null = null;
  let expiresAt: string | null = null;
  let username: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--email':
        email = value ?? null;
        index += 1;
        break;
      case '--role':
        role = value ?? null;
        index += 1;
        break;
      case '--expires-at':
        expiresAt = value ?? null;
        index += 1;
        break;
      case '--username':
        username = value ?? null;
        index += 1;
        break;
      default:
        throw new Error('unknown argument');
    }
  }
  return { email, role, expiresAt, username };
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'invite' && command !== 'disable') {
    stderr.write(
      'usage: account invite --email <email> --role <judge|editor|admin> [--expires-at <instant>]\n' +
        '       account disable --username <name>\n',
    );
    return 2;
  }
  let parsed: Arguments;
  try {
    parsed = parseArguments(rest);
  } catch {
    stderr.write('account: unrecognized argument\n');
    return 2;
  }
  let database: Database | undefined;
  try {
    const config = loadDashboardConfig(process.env);
    if (config.accountStore === 'postgres') {
      const { database: databasePackage } = await workspace();
      database = databasePackage.openDatabase(
        databasePackage.parseDatabaseConfig(process.env, { schema: config.databaseSchema }),
        { maxConnections: 2 },
      );
    }
    const stores = await openStores(config, database);

    if (command === 'invite') {
      const result = await inviteAccount(
        { stores },
        null,
        { email: parsed.email, role: parsed.role, expiresAt: parsed.expiresAt },
        { fromCommandLine: true },
      );
      stdout.write(
        `account: invited email=${parsed.email ?? ''} role=${parsed.role ?? ''} id=${result.accountId}\n`,
      );
      return 0;
    }

    if (parsed.username === null) {
      stderr.write('account: --username is required for disable\n');
      return 2;
    }
    const account = await stores.accounts.findByUsername(parsed.username);
    if (account === null) {
      stderr.write('account: no account with that username\n');
      return 2;
    }
    const now = new Date().toISOString();
    await stores.accounts.setDisabled(account.id, now);
    const revoked = await stores.sessions.revokeAllForAccount(
      account.id,
      now,
      'containment_password_compromise',
      null,
    );
    await stores.audit.append({
      id: randomUUID(),
      at: now,
      kind: 'account_disabled',
      outcome: 'success',
      code: account.role,
      actorAccountId: null,
      subjectAccountId: account.id,
      sessionId: null,
      networkKey: null,
      subjectId: null,
    });
    stdout.write(`account: disabled username=${parsed.username} sessionsRevoked=${revoked}\n`);
    return 0;
  } catch (error) {
    if (isDashboardError(error)) {
      stderr.write(`account: ${error.kind} ${error.code}: ${error.message}\n`);
      return 2;
    }
    stderr.write(`account: unexpected failure ${randomUUID().slice(0, 8)}\n`);
    return 5;
  } finally {
    await database?.end();
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('account.js')) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
