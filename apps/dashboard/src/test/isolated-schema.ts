import { randomBytes } from 'node:crypto';

import {
  createSchema,
  dropSchema,
  openDatabase,
  parseDatabaseConfig,
  runMigrations,
  type Database,
} from '@cas/database';

/**
 * Test-only helper, never part of a build. Opens the database named by
 * DATABASE_URL, creates a schema whose exact name it generated, migrates it
 * with the shipped migrations, and returns a handle scoped to it. `close()`
 * drops only that schema. Fails, rather than skips, without DATABASE_URL.
 */
export interface IsolatedSchema {
  readonly name: string;
  readonly db: Database;
  close(): Promise<void>;
}

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

/** Drops a schema by name, for a teardown that runs in another process. */
export async function dropNamedSchema(name: string): Promise<void> {
  const base = openDatabase(parseDatabaseConfig(process.env), { maxConnections: 1 });
  try {
    await base.withClient((client) => dropSchema(client, name));
  } finally {
    await base.end();
  }
}
