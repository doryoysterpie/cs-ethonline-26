import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from './database.js';
import { openDatabase, parseDatabaseConfig } from './index.js';
import { isDatabaseError } from './errors.js';
import { countAllRows } from './ingestion.js';
import { MIGRATIONS_DIRECTORY, migrationStatus, runMigrations } from './migrate.js';
import { listTables } from './schema.js';
import { migrationsUpTo, openIsolatedSchema, type IsolatedSchema } from './test-support.js';

const EXPECTED_TABLES = [
  'accounts',
  'audit_events',
  'classification_results',
  'classification_runs',
  'clustering_ambiguous_links',
  'clustering_review_actions',
  'clustering_runs',
  'draft_revisions',
  'evidence_review_actions',
  'evidence_runs',
  'graph_signal_runs',
  'graph_signals',
  'import_batches',
  'incident_claims',
  'incident_clusters',
  'incident_evidence_states',
  'incident_memberships',
  'incident_signal_associations',
  'incident_subjects',
  'login_throttle_buckets',
  'otp_challenges',
  'queue_decisions',
  'review_entries',
  'review_snapshots',
  'row_issues',
  'schema_migrations',
  'sessions',
  'source_rows',
  'url_groups',
];

interface SeededBatch {
  readonly batchId: string;
  readonly snapshotId: string;
  readonly rowIds: readonly string[];
}

/**
 * Writes one consistent weekly batch with the shape migration 0001 produced,
 * using plain SQL so it works before migration 0002 adds its columns: two
 * source rows sharing a URL group, one issue, one snapshot and two review
 * entries, one of them on a quarantined row.
 */
async function seedValidBatch(db: Database): Promise<SeededBatch> {
  const batchId = randomUUID();
  const snapshotId = randomUUID();
  const groupId = randomUUID();
  const rowIds = [randomUUID(), randomUUID()];
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO import_batches (
         id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
         header_cells, importer_version, idempotency_key, status, parsed_row_count,
         accepted_row_count, quarantined_row_count, started_at, completed_at
       ) VALUES ($1, 'replay', 'weekly', 'CS79', 'seed.csv', $2, 10, '["ch"]'::jsonb,
                 'editorial-csv-import@1', $3, 'completed_with_issues', 2, 1, 1, now(), now())`,
      [batchId, 'a'.repeat(64), 'b'.repeat(64)],
    );
    await tx.query('INSERT INTO url_groups (id, canonical_url) VALUES ($1, $2)', [
      groupId,
      'https://seed.example/one',
    ]);
    for (const [index, id] of rowIds.entries()) {
      await tx.query(
        `INSERT INTO source_rows (
           id, batch_id, row_number, data_origin, status, raw_cells, raw_fields,
           text_transform, canonical_url, url_group_id, row_hash
         ) VALUES ($1, $2, $3, 'replay', $4, '["TRUE"]'::jsonb, '{"ch":"TRUE"}'::jsonb,
                   'html-to-text@1', $5, $6, $7)`,
        [
          id,
          batchId,
          index + 1,
          index === 0 ? 'accepted' : 'quarantined',
          'https://seed.example/one',
          groupId,
          String(index).repeat(64).slice(0, 64),
        ],
      );
    }
    await tx.query(
      `INSERT INTO row_issues (id, batch_id, source_row_id, issue_code, field, severity, message)
       VALUES ($1, $2, $3, 'url_invalid', 'URL', 'error', 'URL cannot be parsed')`,
      [randomUUID(), batchId, rowIds[1]],
    );
    await tx.query(
      `INSERT INTO review_snapshots (id, batch_id, review_label, data_origin, created_at)
       VALUES ($1, $2, 'CS79', 'replay', now())`,
      [snapshotId, batchId],
    );
    for (const id of rowIds) {
      await tx.query(
        `INSERT INTO review_entries (id, snapshot_id, source_row_id, raw_value, review_state)
         VALUES ($1, $2, $3, 'TRUE', 'selected')`,
        [randomUUID(), snapshotId, id],
      );
    }
  });
  return { batchId, snapshotId, rowIds };
}

describe('migration runner against a fresh schema', () => {
  let isolated: IsolatedSchema;

  beforeEach(async () => {
    isolated = await openIsolatedSchema();
  });

  afterEach(async () => {
    await isolated.close();
  });

  it('migrates a fresh schema through every migration, reruns as a no-op, and reports status', async () => {
    const first = await runMigrations(isolated.db);
    expect(first.applied).toEqual([
      '0001_editorial_ingestion.sql',
      '0002_provenance_integrity.sql',
      '0003_classification.sql',
      '0004_classification_integrity.sql',
      '0005_classification_schema_security.sql',
      '0006_incident_clustering.sql',
      '0007_clustering_integrity.sql',
      '0008_graph_evidence.sql',
      '0009_evidence_integrity.sql',
      '0010_dashboard_persistence.sql',
      '0011_passwordless_email_auth.sql',
    ]);
    expect(first.alreadyApplied).toBe(0);
    expect(first.total).toBe(11);
    const tables = await isolated.base.withClient((c) => listTables(c, isolated.name));
    expect(tables).toEqual(EXPECTED_TABLES);

    const second = await runMigrations(isolated.db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(11);

    const status = await migrationStatus(isolated.db);
    expect(status.pending).toEqual([]);
    expect(status.drift).toEqual([]);
    expect(status.applied.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(status.applied[0]?.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('upgrades a schema that already has 0010 applied and holds a legacy password account, without data loss', async () => {
    const subset = await migrationsUpTo(10);
    try {
      const before = await runMigrations(isolated.db, { directory: subset.directory });
      expect(before.applied.at(-1)).toBe('0010_dashboard_persistence.sql');
      await isolated.db.withClient((c) =>
        c.query(
          `INSERT INTO accounts (id, username, role, password_hash, created_at, password_changed_at)
           VALUES ($1, 'admin', 'admin', $2, now(), now())`,
          [randomUUID(), '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g'],
        ),
      );

      const upgrade = await runMigrations(isolated.db);
      expect(upgrade.applied).toEqual(['0011_passwordless_email_auth.sql']);
      expect(upgrade.alreadyApplied).toBe(10);

      const legacy = await isolated.db.withClient((c) =>
        c.query<{ username: string; normalized_email: string | null; has_password: boolean }>(
          `SELECT username, normalized_email,
                  password_hash IS NOT NULL AS has_password
             FROM accounts WHERE username = 'admin'`,
        ),
      );
      expect(legacy.rows).toEqual([
        { username: 'admin', normalized_email: null, has_password: true },
      ]);
      expect((await migrationStatus(isolated.db)).pending).toEqual([]);
    } finally {
      await subset.cleanup();
    }
  });

  it('refuses 0011 when applied without its 0010 precondition, and leaves no partial table', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cas-migrations-gap-'));
    try {
      for (const fileName of await readdir(MIGRATIONS_DIRECTORY)) {
        if (fileName.startsWith('0010_')) continue; // deliberately omit 0010
        await copyFile(path.join(MIGRATIONS_DIRECTORY, fileName), path.join(directory, fileName));
      }
      await expect(runMigrations(isolated.db, { directory })).rejects.toMatchObject({
        kind: 'migration',
      });
      const table = await isolated.db.withClient((c) =>
        c.query<{ reg: string | null }>(
          "SELECT pg_catalog.to_regclass(pg_catalog.quote_ident($1) || '.otp_challenges')::text AS reg",
          [isolated.name],
        ),
      );
      expect(table.rows[0]?.reg).toBeNull();
      const applied = await isolated.db.withClient((c) =>
        c.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version'),
      );
      expect(applied.rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('upgrades a schema that already has 0001 applied and holds valid rows, without data loss', async () => {
    const subset = await migrationsUpTo(1);
    try {
      const before = await runMigrations(isolated.db, { directory: subset.directory });
      expect(before.applied).toEqual(['0001_editorial_ingestion.sql']);
      await seedValidBatch(isolated.db);
      const counts = await isolated.db.withClient(countAllRows);
      expect(counts).toMatchObject({
        batches: 1,
        sourceRows: 2,
        rowIssues: 1,
        urlGroups: 1,
        reviewSnapshots: 1,
        reviewEntries: 2,
      });

      const upgrade = await runMigrations(isolated.db);
      expect(upgrade.applied).toEqual([
        '0002_provenance_integrity.sql',
        '0003_classification.sql',
        '0004_classification_integrity.sql',
        '0005_classification_schema_security.sql',
        '0006_incident_clustering.sql',
        '0007_clustering_integrity.sql',
        '0008_graph_evidence.sql',
        '0009_evidence_integrity.sql',
        '0010_dashboard_persistence.sql',
        '0011_passwordless_email_auth.sql',
      ]);
      expect(upgrade.alreadyApplied).toBe(1);
      expect(await isolated.db.withClient(countAllRows)).toEqual(counts);

      // The backfilled column is deterministic: every entry names its snapshot's batch.
      const mismatched = await isolated.db.withClient((c) =>
        c.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM review_entries e
             JOIN review_snapshots s ON s.id = e.snapshot_id
            WHERE e.batch_id IS DISTINCT FROM s.batch_id`,
        ),
      );
      expect(mismatched.rows[0]?.count).toBe('0');
      expect((await migrationStatus(isolated.db)).pending).toEqual([]);
    } finally {
      await subset.cleanup();
    }
  });

  it('refuses to upgrade a schema whose existing provenance already contradicts itself, and changes nothing', async () => {
    const subset = await migrationsUpTo(1);
    try {
      await runMigrations(isolated.db, { directory: subset.directory });
      const seeded = await seedValidBatch(isolated.db);
      // Contradiction only possible before 0002: a row whose origin differs
      // from its batch's origin.
      await isolated.db.withClient((c) =>
        c.query("UPDATE source_rows SET data_origin = 'live' WHERE id = $1", [seeded.rowIds[0]]),
      );
      await expect(runMigrations(isolated.db)).rejects.toMatchObject({ kind: 'migration' });
      const applied = await isolated.db.withClient((c) =>
        c.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version'),
      );
      expect(applied.rows.map((r) => r.version)).toEqual([1]);
      const rows = await isolated.db.withClient((c) =>
        c.query<{ data_origin: string }>('SELECT data_origin FROM source_rows WHERE id = $1', [
          seeded.rowIds[0],
        ]),
      );
      // The contradictory row is left exactly as it was, never rewritten.
      expect(rows.rows[0]?.data_origin).toBe('live');
      const columns = await isolated.db.withClient((c) =>
        c.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'review_entries'
              AND column_name = 'batch_id'`,
        ),
      );
      expect(columns.rows[0]?.count).toBe('0');
    } finally {
      await subset.cleanup();
    }
  });

  it('includes migration 0002 in checksum-drift detection', async () => {
    await runMigrations(isolated.db);
    await isolated.db.withClient((c) =>
      c.query("UPDATE schema_migrations SET checksum = repeat('1', 64) WHERE version = 2"),
    );
    await expect(runMigrations(isolated.db)).rejects.toMatchObject({ kind: 'drift' });
    expect((await migrationStatus(isolated.db)).drift).toEqual([
      { version: 2, reason: 'checksum' },
    ]);
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
      // Every migration is applied exactly once in total, whichever runner
      // won the lock; the loser finds nothing pending.
      expect(a.applied.length + b.applied.length).toBe(11);
      expect(Math.min(a.applied.length, b.applied.length)).toBe(0);
      const rows = await isolated.db.withClient((c) =>
        c.query<{ count: string }>('SELECT count(*)::text AS count FROM schema_migrations'),
      );
      expect(rows.rows[0]?.count).toBe('11');
    } finally {
      await other.end();
    }
  });
});
