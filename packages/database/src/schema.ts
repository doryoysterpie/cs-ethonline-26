import { assertSchemaName } from './config.js';
import type { Queryable } from './database.js';

/**
 * Schema helpers used by integration tests to isolate every run in a schema
 * whose exact name the test generated. The name is validated as a plain
 * identifier before it is quoted, so it cannot carry SQL. Nothing here drops
 * anything it did not name explicitly; there is no reset and no wildcard.
 */

export function quoteIdentifier(name: string): string {
  assertSchemaName(name);
  return `"${name}"`;
}

export async function createSchema(client: Queryable, name: string): Promise<void> {
  await client.query(`CREATE SCHEMA ${quoteIdentifier(name)}`);
}

export async function dropSchema(client: Queryable, name: string): Promise<void> {
  await client.query(`DROP SCHEMA ${quoteIdentifier(name)} CASCADE`);
}

export async function listTables(client: Queryable, schema: string): Promise<string[]> {
  assertSchemaName(schema);
  const result = await client.query<{ table_name: string }>(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
    [schema],
  );
  return result.rows.map((row) => row.table_name);
}
