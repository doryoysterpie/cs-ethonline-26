import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSchema,
  dropSchema,
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
  const config = parseDatabaseConfig(process.env);
  const base = openDatabase(config, { maxConnections: 2 });
  const name = `cas_test_${randomBytes(6).toString('hex')}`;
  await base.withClient((client) => createSchema(client, name));
  const db = openDatabase({ ...config, schema: name }, { maxConnections: 4 });
  await runMigrations(db);
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
