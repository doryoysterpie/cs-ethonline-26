import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dropSchema, openDatabase, parseDatabaseConfig } from '@cas/database';

/** Drops the schema the launcher created and deletes the seed and credential files. */
export default async function teardown(): Promise<void> {
  const output = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../test-results/browser',
  );
  let schema: string | null = null;
  try {
    const credentials = JSON.parse(
      await readFile(path.join(output, 'credentials.json'), 'utf8'),
    ) as {
      schema?: string;
    };
    schema = credentials.schema ?? null;
  } catch {
    schema = null;
  }
  if (schema !== null && /^cas_test_[0-9a-f]{12}$/u.test(schema)) {
    const base = openDatabase(parseDatabaseConfig(process.env), { maxConnections: 1 });
    try {
      await base.withClient((client) => dropSchema(client, schema as string));
    } finally {
      await base.end();
    }
  }
  await rm(path.join(output, 'seed.json'), { force: true });
  await rm(path.join(output, 'credentials.json'), { force: true });
}
