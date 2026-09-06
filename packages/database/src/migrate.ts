import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Database, Queryable } from './database.js';
import { DatabaseError } from './errors.js';

/**
 * Deterministic, forward-only migration runner.
 *
 * - Migrations are numbered SQL files under `migrations/` in this package,
 *   applied in numeric order. There is no down migration and no reset.
 * - `schema_migrations` records every applied version with the SHA-256 of
 *   the file that was applied. On every run the stored checksum is compared
 *   with the file on disk; any difference, a renamed file, or an applied
 *   version with no file is drift and stops the run before any change.
 * - Each pending migration runs inside its own transaction and is recorded
 *   in the same transaction, so a failure leaves nothing half applied.
 * - A session-level advisory lock, keyed on the current schema, serializes
 *   concurrent runners: the second waits, then finds nothing pending.
 * - A rerun with nothing pending applies nothing and reports that.
 */

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationDrift {
  readonly version: number;
  readonly reason: 'checksum' | 'name' | 'missing_file';
}

export interface MigrationStatus {
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly string[];
  readonly drift: readonly MigrationDrift[];
}

export interface MigrationRunResult {
  /** File names applied by this run, in order. Empty on a no-op rerun. */
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
  readonly total: number;
}

export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations/', import.meta.url));

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const LOCK_CLASS = 7231;

const CREATE_SCHEMA_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    integer     PRIMARY KEY,
  name       text        NOT NULL,
  checksum   text        NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

export async function loadMigrations(
  directory: string = MIGRATIONS_DIRECTORY,
): Promise<MigrationFile[]> {
  const entries = await readdir(directory);
  const files: MigrationFile[] = [];
  const seen = new Set<number>();
  for (const fileName of entries.sort()) {
    const match = FILE_NAME.exec(fileName);
    if (match === null) continue;
    const version = Number(match[1]);
    const name = match[2] ?? '';
    if (seen.has(version)) {
      throw new DatabaseError('migration', `duplicate migration version ${version}`, {
        details: { version },
      });
    }
    seen.add(version);
    const bytes = await readFile(path.join(directory, fileName));
    files.push({
      version,
      name,
      fileName,
      sql: bytes.toString('utf8'),
      checksum: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  files.sort((a, b) => a.version - b.version);
  return files;
}

async function readApplied(client: Queryable): Promise<AppliedMigration[]> {
  const result = await client.query<{
    version: number;
    name: string;
    checksum: string;
    applied_at: string;
  }>(
    "SELECT version, name, checksum, to_json(applied_at) #>> '{}' AS applied_at FROM schema_migrations ORDER BY version",
  );
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

function detectDrift(
  applied: readonly AppliedMigration[],
  files: readonly MigrationFile[],
): MigrationDrift[] {
  const byVersion = new Map(files.map((file) => [file.version, file]));
  const drift: MigrationDrift[] = [];
  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (file === undefined) drift.push({ version: row.version, reason: 'missing_file' });
    else if (file.checksum !== row.checksum)
      drift.push({ version: row.version, reason: 'checksum' });
    else if (file.name !== row.name) drift.push({ version: row.version, reason: 'name' });
  }
  return drift;
}

async function withMigrationLock<T>(
  db: Database,
  fn: (client: Queryable) => Promise<T>,
): Promise<T> {
  return db.withClient(async (client) => {
    await client.query('SELECT pg_advisory_lock($1::int, hashtext(current_schema()))', [
      LOCK_CLASS,
    ]);
    try {
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::int, hashtext(current_schema()))', [
        LOCK_CLASS,
      ]);
    }
  });
}

function driftError(drift: readonly MigrationDrift[]): DatabaseError {
  const first = drift[0];
  return new DatabaseError(
    'drift',
    `migration drift detected: ${drift.length} applied migration(s) differ from the files on disk`,
    {
      details: {
        count: drift.length,
        firstVersion: first?.version ?? null,
        firstReason: first?.reason ?? null,
      },
    },
  );
}

export async function migrationStatus(
  db: Database,
  options: { readonly directory?: string | undefined } = {},
): Promise<MigrationStatus> {
  const files = await loadMigrations(options.directory);
  return withMigrationLock(db, async (client) => {
    await client.query(CREATE_SCHEMA_MIGRATIONS);
    const applied = await readApplied(client);
    const appliedVersions = new Set(applied.map((row) => row.version));
    return {
      applied,
      pending: files.filter((file) => !appliedVersions.has(file.version)).map((f) => f.fileName),
      drift: detectDrift(applied, files),
    };
  });
}

export async function runMigrations(
  db: Database,
  options: { readonly directory?: string | undefined } = {},
): Promise<MigrationRunResult> {
  const files = await loadMigrations(options.directory);
  if (files.length === 0) {
    throw new DatabaseError('migration', 'no migration files found');
  }
  return withMigrationLock(db, async (client) => {
    await client.query(CREATE_SCHEMA_MIGRATIONS);
    const applied = await readApplied(client);
    const drift = detectDrift(applied, files);
    if (drift.length > 0) throw driftError(drift);
    const appliedVersions = new Set(applied.map((row) => row.version));
    const appliedNow: string[] = [];
    for (const file of files) {
      if (appliedVersions.has(file.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [file.version, file.name, file.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        const code = error instanceof DatabaseError ? error.code : null;
        throw new DatabaseError(
          'migration',
          `migration ${file.fileName} failed and was rolled back`,
          {
            code,
            details: { version: file.version, fileName: file.fileName },
          },
        );
      }
      appliedNow.push(file.fileName);
    }
    return { applied: appliedNow, alreadyApplied: applied.length, total: files.length };
  });
}
