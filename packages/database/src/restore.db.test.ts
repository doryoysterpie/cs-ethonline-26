import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadMigrations, runMigrations } from './migrate.js';
import { countSchemaRows } from './restore.js';
import { openIsolatedSchema, type IsolatedSchema } from './test-support.js';

describe('read-only restore inspection', () => {
  let isolated: IsolatedSchema;

  beforeEach(async () => {
    isolated = await openIsolatedSchema();
    await runMigrations(isolated.db);
  });

  afterEach(async () => {
    await isolated.close();
  });

  it('counts every table exactly and rejects a write in the source transaction', async () => {
    const counts = await isolated.db.withTransaction(
      (client) => countSchemaRows(client, isolated.name),
      { isolationLevel: 'repeatable read', readOnly: true },
    );
    expect(counts.map((row) => row.table)).toContain('schema_migrations');
    // Read from the migrations directory, so a new migration does not make this stale (D51).
    expect(counts.find((row) => row.table === 'schema_migrations')?.rows).toBe(
      String((await loadMigrations()).length),
    );

    await expect(
      isolated.db.withTransaction(
        (client) => client.query("INSERT INTO url_groups (canonical_url) VALUES ('x')"),
        { readOnly: true },
      ),
    ).rejects.toMatchObject({ kind: 'query', code: '25006' });
  });
});
