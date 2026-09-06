import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseDatabaseConfig } from './config.js';
import { Database, openDatabase } from './database.js';
import { MIGRATIONS_DIRECTORY } from './migrate.js';
import { createSchema, dropSchema } from './schema.js';

/**
 * Test-only helpers, excluded from the build. Opens the database named by
 * DATABASE_URL, creates a schema whose exact name it generated, and returns a
 * handle scoped to that schema. `close()` drops only that schema. Fails,
 * rather than skips, when DATABASE_URL is missing.
 */

export interface IsolatedSchema {
  readonly name: string;
  readonly db: Database;
  readonly base: Database;
  close(): Promise<void>;
}

export async function openIsolatedSchema(): Promise<IsolatedSchema> {
  const config = parseDatabaseConfig(process.env);
  const base = openDatabase(config, { maxConnections: 2 });
  const name = `cas_test_${randomBytes(6).toString('hex')}`;
  await base.withClient((client) => createSchema(client, name));
  const db = openDatabase({ ...config, schema: name }, { maxConnections: 4 });
  return {
    name,
    db,
    base,
    async close() {
      await db.end();
      await base.withClient((client) => dropSchema(client, name));
      await base.end();
    },
  };
}

export interface MigrationSubset {
  readonly directory: string;
  cleanup(): Promise<void>;
}

/**
 * A temporary directory holding copies of the shipped migrations up to and
 * including `maxVersion`, so a test can place a schema at an earlier point
 * in history before upgrading it with the full set.
 */
export async function migrationsUpTo(maxVersion: number): Promise<MigrationSubset> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cas-migrations-subset-'));
  for (const fileName of await readdir(MIGRATIONS_DIRECTORY)) {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(fileName);
    if (match === null || Number(match[1]) > maxVersion) continue;
    await copyFile(path.join(MIGRATIONS_DIRECTORY, fileName), path.join(directory, fileName));
  }
  return {
    directory,
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
