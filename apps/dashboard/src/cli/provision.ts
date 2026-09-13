import { randomUUID } from 'node:crypto';
import { stdin, stdout, stderr } from 'node:process';

import type { Database } from '@cas/database';

import { SessionService } from '../server/auth/session.ts';
import { openStores } from '../server/auth/stores.ts';
import { loadDashboardConfig } from '../server/config.ts';
import { provisionAccount } from '../server/dal/mutate.ts';
import { isDashboardError } from '../server/errors.ts';
import { workspace } from '../server/packages.ts';

/**
 * One-time account provisioning.
 *
 *   corepack pnpm --filter @cas/dashboard provision --username <name> --role <role> [--expires-at <instant>] [--rotate]
 *
 * The password is read from the terminal twice with echo disabled and never
 * appears in an argument, an environment variable, a file, a log line or this
 * process's output. It is validated, normalised, hashed with Argon2id under
 * a fresh salt, and the hash alone is stored through the configured store.
 * With the memory store that is the seed file named by
 * `DASHBOARD_MEMORY_STORE_SEED`; with the PostgreSQL store the command fails
 * with the fixed persistence-paused message, because that store is not yet
 * allocated a migration number.
 *
 * Exit codes: 0 provisioned, 2 configuration or validation, 5 unexpected.
 */

interface Arguments {
  readonly username: string | null;
  readonly role: string | null;
  readonly expiresAt: string | null;
  readonly rotate: boolean;
}

function parseArguments(argv: readonly string[]): Arguments {
  let username: string | null = null;
  let role: string | null = null;
  let expiresAt: string | null = null;
  let rotate = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--username':
        username = value ?? null;
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
      case '--rotate':
        rotate = true;
        break;
      default:
        throw new Error('unknown argument');
    }
  }
  return { username, role, expiresAt, rotate };
}

/** Reads one line from a TTY without echoing it. Refuses a non-terminal. */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      reject(new Error('the password must be typed on a terminal'));
      return;
    }
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buffer = '';
    const finish = (error: Error | null): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      if (error !== null) reject(error);
      else resolve(buffer);
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish(new Error('interrupted'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish(null);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += character;
      }
    };
    stdin.on('data', onData);
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: Arguments;
  try {
    parsed = parseArguments(argv);
  } catch {
    stderr.write(
      'usage: provision --username <name> --role <judge|editor|admin> [--expires-at <instant>] [--rotate]\n',
    );
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
    const sessions = new SessionService(stores);
    const first = await readSecret('Replacement password (not echoed): ');
    const second = await readSecret('Again: ');
    if (first !== second) {
      stderr.write('provision: the two entries differ; nothing was stored\n');
      return 2;
    }
    const result = await provisionAccount(
      { stores, sessions },
      null,
      {
        username: parsed.username,
        role: parsed.role,
        expiresAt: parsed.expiresAt,
        password: first,
        rotate: parsed.rotate,
      },
      { fromCommandLine: true },
    );
    stdout.write(
      `provision: account=${parsed.username ?? ''} role=${parsed.role ?? ''} outcome=${result.outcome} id=${result.accountId} store=${config.accountStore}\n`,
    );
    return 0;
  } catch (error) {
    if (isDashboardError(error)) {
      stderr.write(`provision: ${error.kind} ${error.code}: ${error.message}\n`);
      return 2;
    }
    if (
      error instanceof Error &&
      (error.message === 'interrupted' || error.message.startsWith('the password'))
    ) {
      stderr.write(`provision: ${error.message}\n`);
      return 2;
    }
    stderr.write(`provision: unexpected failure ${randomUUID().slice(0, 8)}\n`);
    return 5;
  } finally {
    await database?.end();
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('provision.js')) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
