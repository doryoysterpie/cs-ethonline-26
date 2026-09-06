import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, parseDatabaseConfig } from './index.js';
import { isDatabaseError } from './errors.js';
import { migrationStatus, runMigrations } from './migrate.js';
import { listTables } from './schema.js';
import { openIsolatedSchema, type IsolatedSchema } from './test-support.js';

const EXPECTED_TABLES = [
  'import_batches',
  'review_entries',
  'review_snapshots',
  'row_issues',
  'schema_migrations',
  'source_rows',
  'url_groups',
];

describe('migration runner against a fresh schema', () => {
  let isolated: IsolatedSchema;

  beforeEach(async () => {
    isolated = await openIsolatedSchema();
  });

  afterEach(async () => {
    await isolated.close();
  });

  it('migrates a fresh schema, reruns as a no-op, and reports status', async () => {
    const first = await runMigrations(isolated.db);
    expect(first.applied).toEqual(['0001_editorial_ingestion.sql']);
    expect(first.alreadyApplied).toBe(0);
    expect(first.total).toBe(1);
    const tables = await isolated.base.withClient((c) => listTables(c, isolated.name));
    expect(tables).toEqual(EXPECTED_TABLES);

    const second = await runMigrations(isolated.db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(1);

    const status = await migrationStatus(isolated.db);
    expect(status.pending).toEqual([]);
    expect(status.drift).toEqual([]);
    expect(status.applied.map((m) => m.version)).toEqual([1]);
    expect(status.applied[0]?.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('detects checksum drift and refuses to run', async () => {
    await runMigrations(isolated.db);
    await isolated.db.withClient((c) =>
      c.query("UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = 1"),
    );
    let caught: unknown;
    try {
      await runMigrations(isolated.db);
    } catch (error) {
      caught = error;
    }
    expect(isDatabaseError(caught) && caught.kind === 'drift').toBe(true);
    expect((await migrationStatus(isolated.db)).drift).toEqual([
      { version: 1, reason: 'checksum' },
    ]);
  });

  it('treats an applied version with no file as drift', async () => {
    await runMigrations(isolated.db);
    await isolated.db.withClient((c) =>
      c.query('INSERT INTO schema_migrations (version, name, checksum) VALUES (99, $1, $2)', [
        'phantom',
        'f'.repeat(64),
      ]),
    );
    await expect(runMigrations(isolated.db)).rejects.toMatchObject({ kind: 'drift' });
    expect((await migrationStatus(isolated.db)).drift).toEqual([
      { version: 99, reason: 'missing_file' },
    ]);
  });

  it('serializes concurrent runners with the advisory lock so each migration applies once', async () => {
    const config = parseDatabaseConfig(process.env);
    const other = openDatabase({ ...config, schema: isolated.name }, { maxConnections: 2 });
    try {
      const [a, b] = await Promise.all([runMigrations(isolated.db), runMigrations(other)]);
      expect(a.applied.length + b.applied.length).toBe(1);
      const rows = await isolated.db.withClient((c) =>
        c.query<{ count: string }>('SELECT count(*)::text AS count FROM schema_migrations'),
      );
      expect(rows.rows[0]?.count).toBe('1');
    } finally {
      await other.end();
    }
  });
});
