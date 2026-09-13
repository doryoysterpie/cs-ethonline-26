import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSchema,
  dropSchema,
  MIGRATIONS_DIRECTORY,
  openDatabase,
  parseDatabaseConfig,
  runMigrations,
  type Database,
} from '@cas/database';

/**
 * Test-only helpers, excluded from the build.
 */

export const FIXTURES_DIRECTORY = fileURLToPath(
  new URL('../../../data/fixtures/editorial/', import.meta.url),
);

export function fixture(name: string): string {
  return path.join(FIXTURES_DIRECTORY, name);
}

export interface IsolatedSchema {
  readonly name: string;
  readonly db: Database;
  close(): Promise<void>;
}

/**
 * Opens the database named by DATABASE_URL, creates a schema whose exact
 * name it generated, migrates it, and returns a handle scoped to it.
 * `close()` drops only that schema. Fails, rather than skips, without
 * DATABASE_URL.
 */
export async function openMigratedSchema(): Promise<IsolatedSchema> {
  return openSchemaMigratedTo(Number.MAX_SAFE_INTEGER);
}

/**
 * The same, stopped after migration `maxVersion`. A test that must build a
 * state a later migration forbids has to build it before that migration runs.
 */
export async function openSchemaMigratedTo(maxVersion: number): Promise<IsolatedSchema> {
  const config = parseDatabaseConfig(process.env);
  const base = openDatabase(config, { maxConnections: 2 });
  const name = `cas_test_${randomBytes(6).toString('hex')}`;
  await base.withClient((client) => createSchema(client, name));
  const db = openDatabase({ ...config, schema: name }, { maxConnections: 4 });
  const subset = maxVersion === Number.MAX_SAFE_INTEGER ? null : await migrationsUpTo(maxVersion);
  try {
    await runMigrations(db, subset === null ? {} : { directory: subset.directory });
  } finally {
    if (subset !== null) await subset.cleanup();
  }
  return {
    name,
    db,
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

/** Copies of the shipped migrations up to and including `maxVersion`. */
export async function migrationsUpTo(maxVersion: number): Promise<MigrationSubset> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cas-worker-migrations-'));
  for (const fileName of await readdir(MIGRATIONS_DIRECTORY)) {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/u.exec(fileName);
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
