import { assertSchemaName, summarizeConnection } from './config.js';
import type { Queryable } from './database.js';
import { DatabaseError } from './errors.js';
import { listTables, quoteIdentifier } from './schema.js';

export interface TableRowCount {
  readonly table: string;
  readonly rows: string;
}

export interface RowCountDifference {
  readonly table: string;
  readonly source: string | null;
  readonly restored: string | null;
}

const RESTORE_DATABASE_NAME = /^cas_restore_[a-z0-9_]{1,51}$/;
const DECIMAL_COUNT = /^(0|[1-9][0-9]*)$/;

function databaseName(connectionString: string): string {
  const url = new URL(connectionString);
  let name: string;
  try {
    name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    throw new DatabaseError(
      'configuration',
      'restore database rejected: database name is not valid percent-encoding',
    );
  }
  if (name.length === 0 || name.includes('/')) {
    throw new DatabaseError('configuration', 'restore database rejected: database name is missing');
  }
  return name;
}

function databaseIdentity(connectionString: string): string {
  const url = new URL(connectionString);
  const hostParameter = url.searchParams.get('host');
  const summary = summarizeConnection(connectionString);
  const host =
    summary.transport === 'remote-tcp'
      ? (hostParameter ?? url.hostname.toLowerCase())
      : 'local-postgres';
  const port = url.port.length === 0 ? '5432' : url.port;
  return `${host}\u0000${port}\u0000${databaseName(connectionString)}`;
}

/**
 * Refuses any target that could plausibly be production. The drill may read a
 * remote source, but restores only to a separately named local database.
 */
export function assertRestoreDrillSafety(
  sourceConnectionString: string,
  restoreConnectionString: string,
): void {
  const target = summarizeConnection(restoreConnectionString);
  if (target.transport === 'remote-tcp') {
    throw new DatabaseError(
      'configuration',
      'restore target rejected: only loopback TCP or a local Unix socket is allowed',
    );
  }
  if (!RESTORE_DATABASE_NAME.test(databaseName(restoreConnectionString))) {
    throw new DatabaseError(
      'configuration',
      'restore target rejected: database name must begin with cas_restore_',
    );
  }
  if (databaseIdentity(sourceConnectionString) === databaseIdentity(restoreConnectionString)) {
    throw new DatabaseError(
      'configuration',
      'restore target rejected: source and target identify the same database',
    );
  }
}

/** Exact counts, not planner estimates, returned as decimal strings. */
export async function countSchemaRows(
  client: Queryable,
  schema: string,
): Promise<readonly TableRowCount[]> {
  assertSchemaName(schema);
  const tables = await listTables(client, schema);
  const counts: TableRowCount[] = [];
  for (const table of tables) {
    const result = await client.query<{ rows: string }>(
      `SELECT pg_catalog.count(*)::text AS rows FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`,
    );
    const rows = result.rows[0]?.rows;
    if (rows === undefined || !DECIMAL_COUNT.test(rows)) {
      throw new DatabaseError('query', 'table row count returned an invalid value');
    }
    counts.push({ table, rows });
  }
  return counts;
}

export function compareTableRowCounts(
  source: readonly TableRowCount[],
  restored: readonly TableRowCount[],
): readonly RowCountDifference[] {
  const sourceByTable = new Map(source.map((row) => [row.table, row.rows]));
  const restoredByTable = new Map(restored.map((row) => [row.table, row.rows]));
  const tables = [...new Set([...sourceByTable.keys(), ...restoredByTable.keys()])].sort();
  return tables.flatMap((table) => {
    const sourceRows = sourceByTable.get(table) ?? null;
    const restoredRows = restoredByTable.get(table) ?? null;
    return sourceRows === restoredRows
      ? []
      : [{ table, source: sourceRows, restored: restoredRows }];
  });
}

export function parseRestoreDrillTimeout(raw: string | undefined): number {
  if (raw === undefined) return 300_000;
  if (!/^[0-9]+$/.test(raw)) {
    throw new DatabaseError(
      'configuration',
      'RESTORE_DRILL_TIMEOUT_SECONDS rejected: expected an integer from 30 to 3600',
    );
  }
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 3600) {
    throw new DatabaseError(
      'configuration',
      'RESTORE_DRILL_TIMEOUT_SECONDS rejected: expected an integer from 30 to 3600',
    );
  }
  return seconds * 1_000;
}
