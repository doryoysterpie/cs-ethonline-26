import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  completeClassificationRun,
  freezeBatchSourceSet,
  insertRunningClassificationRun,
} from './classification.js';
import { parseDatabaseConfig } from './config.js';
import { openDatabase, type Database } from './database.js';
import { isDatabaseError } from './errors.js';
import { migrationStatus, runMigrations } from './migrate.js';
import { quoteIdentifier } from './schema.js';
import { openIsolatedSchema, type IsolatedSchema } from './test-support.js';

/**
 * Schema-capture regressions for migration 0005.
 *
 * Codex Desktop's re-audit created a schema named after the application role
 * and put shadow `classification_results`, `source_rows` and
 * `schema_migrations` tables in it. Because migration 0004's guard functions
 * stored `search_path = "$user", public` and the connection set no explicit
 * path, the shadow tables answered for the real ones: a run holding no results
 * completed against a batch that held a row, and the migration runner reported
 * four applied migrations as none.
 *
 * This file recreates that setup and proves the capture no longer works. It
 * creates the role-named schema for real, so it also proves the rest of the
 * suite is unaffected by its existence.
 */

const SHADOW_TABLES = `
  CREATE TABLE IF NOT EXISTS %S.classification_results (
    id uuid PRIMARY KEY, run_id uuid, batch_id uuid, source_row_id uuid,
    decision text, rationale_codes jsonb, matched_signals jsonb,
    signal_score integer, row_hash text, created_at timestamptz);
  CREATE TABLE IF NOT EXISTS %S.source_rows (
    id uuid PRIMARY KEY, batch_id uuid, row_number integer, row_hash text);
  CREATE TABLE IF NOT EXISTS %S.classification_runs (
    id uuid PRIMARY KEY, batch_id uuid, status text);
  CREATE TABLE IF NOT EXISTS %S.import_batches (
    id uuid PRIMARY KEY, source_set_frozen_at timestamptz, source_set_version integer);
  CREATE TABLE IF NOT EXISTS %S.incident_memberships (
    id uuid PRIMARY KEY, clustering_run_id uuid, source_row_id uuid);
  CREATE TABLE IF NOT EXISTS %S.incident_clusters (
    id uuid PRIMARY KEY, clustering_run_id uuid, member_count integer);
  CREATE TABLE IF NOT EXISTS %S.clustering_runs (
    id uuid PRIMARY KEY, status text);
  CREATE TABLE IF NOT EXISTS %S.schema_migrations (
    version integer PRIMARY KEY, name text, checksum text,
    applied_at timestamptz DEFAULT now());`;

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

describe('search-path capture (migration 0005)', () => {
  let isolated: IsolatedSchema;
  let base: Database;
  let role = '';
  let createdShadow = false;
  let batchId = '';
  let rowId = '';

  beforeAll(async () => {
    base = openDatabase(parseDatabaseConfig(process.env), { maxConnections: 2 });
    role = await base.withClient(async (client) => {
      // `current_user` is a reserved SQL construct, not a schema-qualifiable
      // function, so it is written bare here.
      const result = await client.query<{ role: string }>('SELECT current_user::text AS role');
      return result.rows[0]?.role ?? '';
    });
    expect(role).toMatch(/^[a-z_][a-z0-9_]*$/u);
    const existed = await base.withClient(async (client) => {
      const result = await client.query<{ present: boolean }>(
        'SELECT true AS present FROM pg_catalog.pg_namespace WHERE nspname = $1',
        [role],
      );
      return result.rows.length > 0;
    });
    if (!existed) {
      await base.withClient(async (client) => {
        await client.query(`CREATE SCHEMA ${quoteIdentifier(role)}`);
      });
      createdShadow = true;
    }
    await base.withClient(async (client) => {
      await client.query(SHADOW_TABLES.replaceAll('%S', quoteIdentifier(role)));
    });

    isolated = await openIsolatedSchema();
    await runMigrations(isolated.db);

    // One real batch with one real source row and no classification results.
    batchId = randomUUID();
    rowId = randomUUID();
    await isolated.db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO import_batches (
           id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
           header_cells, importer_version, idempotency_key, status, parsed_row_count,
           accepted_row_count, quarantined_row_count, started_at, completed_at
         ) VALUES ($1, 'replay', 'weekly', 'CS90', 'seed.csv', $2, 10, '["ch"]'::jsonb,
                   'editorial-csv-import@1', $3, 'completed', 1, 1, 0, now(), now())`,
        [batchId, hash('a'), randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64)],
      );
      await tx.query(
        `INSERT INTO source_rows (
           id, batch_id, row_number, data_origin, status, raw_cells, raw_fields,
           normalized_title, text_transform, row_hash
         ) VALUES ($1, $2, 1, 'replay', 'accepted', '["x"]'::jsonb, '{}'::jsonb,
                   'a title', 'html-to-text@1', $3)`,
        [rowId, batchId, hash('1')],
      );
    });
  });

  afterAll(async () => {
    await base.withClient(async (client) => {
      if (createdShadow) await client.query(`DROP SCHEMA ${quoteIdentifier(role)} CASCADE`);
      else {
        for (const table of [
          'classification_results',
          'source_rows',
          'classification_runs',
          'import_batches',
          'schema_migrations',
          'incident_memberships',
          'incident_clusters',
          'clustering_runs',
        ]) {
          await client.query(`DROP TABLE IF EXISTS ${quoteIdentifier(role)}.${table}`);
        }
      }
    });
    await isolated.close();
    await base.end();
  });

  it('stores no $user entry in any integrity function, and binds each to the real schema', async () => {
    const functions = await isolated.base.withClient((client) =>
      client.query<{ name: string; config: string | null; body: string }>(
        `SELECT p.proname AS name,
                pg_catalog.array_to_string(p.proconfig, ',') AS config,
                pg_catalog.pg_get_functiondef(p.oid) AS body
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1
          ORDER BY p.proname`,
        [isolated.name],
      ),
    );
    expect(functions.rows.map((row) => row.name)).toEqual([
      'association_append_only_guard',
      'classification_result_guard',
      'classification_run_guard',
      'clustering_output_guard',
      'clustering_review_guard',
      'clustering_review_payload_digest',
      'clustering_run_guard',
      'evidence_action_append_only_guard',
      'evidence_output_guard',
      'evidence_run_guard',
      'frozen_batch_truncate_guard',
      'graph_signal_run_guard',
      'import_batch_freeze_guard',
      'source_rows_freeze_guard',
    ]);
    for (const row of functions.rows) {
      expect(row.config, row.name).toBe(`search_path=pg_catalog, ${isolated.name}, pg_temp`);
      expect(row.config, row.name).not.toContain('$user');
      // Every application relation the function reads is named by schema.
      expect(row.body, row.name).toContain(`${isolated.name}.`);
    }
  });

  it('refuses to complete an incomplete real run even when shadow tables answer first', async () => {
    const runId = randomUUID();
    let caught: unknown;
    try {
      await isolated.db.withTransaction(async (tx) => {
        // Put the role's own schema first, exactly as a default connection
        // would. The guard functions must ignore it.
        await tx.query(
          `SET LOCAL search_path = ${quoteIdentifier(role)}, ${quoteIdentifier(isolated.name)}`,
        );
        await freezeBatchSourceSet(tx, batchId);
        await insertRunningClassificationRun(tx, {
          id: runId,
          batchId,
          dataOrigin: 'replay',
          classifierVersion: 'rules-classifier@3',
          rulesetVersion: 'classification-behavior-contract@2',
          rulesetHash: hash('f'),
          mode: 'rules',
          idempotencyKey: randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
          expectedRowCount: 1,
          startedAt: new Date().toISOString(),
        });
        // No results are written at all. The shadow `classification_results`
        // is empty and so is the real one, but the real batch holds one row,
        // so the coverage check must refuse this.
        await completeClassificationRun(
          tx,
          runId,
          { total: 0, include: 0, exclude: 0, review: 0 },
          new Date().toISOString(),
        );
      });
    } catch (error) {
      caught = error;
    }
    expect(isDatabaseError(caught)).toBe(true);
    const stored = await isolated.db.withClient((client) =>
      client.query<{ status: string }>('SELECT status FROM classification_runs WHERE id = $1', [
        runId,
      ]),
    );
    expect(stored.rows).toEqual([]);
  });

  it('refuses the same bypass through a temporary schema', async () => {
    const runId = randomUUID();
    let caught: unknown;
    try {
      await isolated.db.withTransaction(async (tx) => {
        await tx.query(
          `CREATE TEMPORARY TABLE source_rows (id uuid, batch_id uuid, row_number integer, row_hash text) ON COMMIT DROP`,
        );
        await tx.query(
          `CREATE TEMPORARY TABLE classification_results (id uuid, run_id uuid) ON COMMIT DROP`,
        );
        await tx.query(`SET LOCAL search_path = pg_temp, ${quoteIdentifier(isolated.name)}`);
        await freezeBatchSourceSet(tx, batchId);
        await insertRunningClassificationRun(tx, {
          id: runId,
          batchId,
          dataOrigin: 'replay',
          classifierVersion: 'rules-classifier@3',
          rulesetVersion: 'classification-behavior-contract@2',
          rulesetHash: hash('e'),
          mode: 'rules',
          idempotencyKey: randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
          expectedRowCount: 1,
          startedAt: new Date().toISOString(),
        });
        await completeClassificationRun(
          tx,
          runId,
          { total: 0, include: 0, exclude: 0, review: 0 },
          new Date().toISOString(),
        );
      });
    } catch (error) {
      caught = error;
    }
    expect(isDatabaseError(caught)).toBe(true);
    const stored = await isolated.db.withClient((client) =>
      client.query<{ status: string }>('SELECT status FROM classification_runs WHERE id = $1', [
        runId,
      ]),
    );
    expect(stored.rows).toEqual([]);
  });

  it('reads and writes the intended migration table, never the shadow one', async () => {
    const status = await migrationStatus(isolated.db);
    expect(status.pending).toEqual([]);
    expect(status.drift).toEqual([]);
    expect(status.applied).toHaveLength(8);
    // A rerun stays a no-op rather than reapplying into the shadow schema.
    expect((await runMigrations(isolated.db)).applied).toEqual([]);

    const shadow = await base.withClient((client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${quoteIdentifier(role)}.schema_migrations`,
      ),
    );
    expect(shadow.rows[0]?.count).toBe('0');
    const real = await isolated.db.withClient((client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${quoteIdentifier(isolated.name)}.schema_migrations`,
      ),
    );
    expect(real.rows[0]?.count).toBe('8');
  });

  it('leaves every shadow table empty', async () => {
    for (const table of [
      'classification_results',
      'source_rows',
      'classification_runs',
      'incident_memberships',
      'incident_clusters',
      'clustering_runs',
    ]) {
      const rows = await base.withClient((client) =>
        client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${quoteIdentifier(role)}.${table}`,
        ),
      );
      expect(rows.rows[0]?.count, table).toBe('0');
    }
  });

  it('gives every connection one explicit application schema', async () => {
    const production = openDatabase(parseDatabaseConfig(process.env));
    try {
      expect(production.schema).toBe('public');
      const path = await production.withClient((client) =>
        client.query<{ path: string }>(`SELECT pg_catalog.current_setting('search_path') AS path`),
      );
      expect(path.rows[0]?.path).toBe('public,pg_temp');
    } finally {
      await production.end();
    }
    const scoped = await isolated.db.withClient((client) =>
      client.query<{ path: string }>(`SELECT pg_catalog.current_setting('search_path') AS path`),
    );
    expect(scoped.rows[0]?.path).toBe(`${isolated.name},pg_temp`);
    // The role-named schema exists throughout this file and never appears.
    expect(scoped.rows[0]?.path).not.toContain(role);
  });
});
