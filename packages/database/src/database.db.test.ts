import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isDatabaseError } from './errors.js';
import { countAllRows, ensureUrlGroups } from './ingestion.js';
import { runMigrations } from './migrate.js';
import { listTables } from './schema.js';
import { openIsolatedSchema, type IsolatedSchema } from './test-support.js';

const SQL_LOOKING = "https://hostile.example/'); DROP TABLE url_groups; --";

describe('Database transactions and parameterization', () => {
  let isolated: IsolatedSchema;

  beforeEach(async () => {
    isolated = await openIsolatedSchema();
    await runMigrations(isolated.db);
  });

  afterEach(async () => {
    await isolated.close();
  });

  it('rolls back everything written inside a transaction whose callback throws', async () => {
    await expect(
      isolated.db.withTransaction(async (tx) => {
        await ensureUrlGroups(tx, ['https://a.example/'], () => crypto.randomUUID());
        throw new Error('deliberate failure');
      }),
    ).rejects.toThrowError('deliberate failure');
    expect((await isolated.db.withClient(countAllRows)).urlGroups).toBe(0);
  });

  it('commits when the callback resolves', async () => {
    await isolated.db.withTransaction((tx) =>
      ensureUrlGroups(tx, ['https://a.example/'], () => crypto.randomUUID()),
    );
    expect((await isolated.db.withClient(countAllRows)).urlGroups).toBe(1);
  });

  it('stores SQL-looking values as inert data', async () => {
    const groups = await isolated.db.withTransaction((tx) =>
      ensureUrlGroups(tx, [SQL_LOOKING], () => crypto.randomUUID()),
    );
    expect(groups.get(SQL_LOOKING)).toMatch(/^[0-9a-f-]{36}$/);
    const stored = await isolated.db.withClient((c) =>
      c.query<{ canonical_url: string }>('SELECT canonical_url FROM url_groups'),
    );
    expect(stored.rows.map((r) => r.canonical_url)).toEqual([SQL_LOOKING]);
    const tables = await isolated.base.withClient((c) => listTables(c, isolated.name));
    expect(tables).toContain('url_groups');
  });

  it('classifies a query failure without copying the driver message', async () => {
    let caught: unknown;
    try {
      await isolated.db.withClient((c) =>
        c.query('SELECT * FROM table_that_does_not_exist_marker'),
      );
    } catch (error) {
      caught = error;
    }
    expect(isDatabaseError(caught)).toBe(true);
    if (isDatabaseError(caught)) {
      expect(caught.kind).toBe('query');
      expect(caught.code).toBe('42P01');
      expect(caught.message).not.toContain('marker');
    }
  });

  it('scopes every connection to the isolated schema', async () => {
    const schema = await isolated.db.withClient((c) =>
      c.query<{ s: string }>('SELECT current_schema() AS s'),
    );
    expect(schema.rows[0]?.s).toBe(isolated.name);
  });
});
