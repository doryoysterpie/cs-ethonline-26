import { randomBytes } from 'node:crypto';

import { parseDatabaseConfig } from './config.js';
import { Database, openDatabase } from './database.js';
import { createSchema, dropSchema } from './schema.js';

/**
 * Test-only helper, excluded from the build. Opens the database named by
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
