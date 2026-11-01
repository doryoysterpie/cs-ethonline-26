import { assertSchemaName, type ConnectionTransport } from './config.js';
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

/**
 * The libpq parameters a restore-drill URL may carry. Any other, `port`,
 * `hostaddr`, `service` and `passfile` among them, could send one of the
 * drill's clients somewhere the guard did not check, and refuses the URL.
 */
const DRILL_PARAMETERS: ReadonlySet<string> = new Set([
  'application_name',
  'channel_binding',
  'connect_timeout',
  'host',
  'options',
  'ssl',
  'sslcert',
  'sslcrl',
  'sslkey',
  'sslmode',
  'sslrootcert',
  'target_session_attrs',
]);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Where one drill URL connects, read once. The guard checks this target, and
 * the child tools are handed exactly it (`drillChildEnvironment`); the Node
 * client reads the same URL to the same host, port and database, because
 * every parameter that could make the two disagree is refused here.
 */
export interface DrillTarget {
  readonly transport: ConnectionTransport;
  /** The effective host: a host name, an address, or a socket directory. */
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string | null;
  readonly password: string | null;
  readonly parameters: ReadonlyMap<string, string>;
}

function drillRefusal(reason: string): DatabaseError {
  return new DatabaseError('configuration', `restore drill URL rejected: ${reason}`);
}

function decoded(value: string, what: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw drillRefusal(`${what} is not valid percent-encoding`);
  }
}

export function drillTarget(connectionString: string): DrillTarget {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw drillRefusal('not a URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw drillRefusal('scheme must be postgres or postgresql');
  }
  const parameters = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!DRILL_PARAMETERS.has(key)) throw drillRefusal('it carries an unsupported libpq parameter');
    if (parameters.has(key)) throw drillRefusal('it names a libpq parameter twice');
    parameters.set(key, value);
  }
  // The `host` parameter overrides the authority, for libpq and the Node client alike.
  const host = parameters.get('host') ?? decoded(url.hostname, 'the host');
  parameters.delete('host');
  if (host.length === 0) throw drillRefusal('it names no host');
  if (host.includes(',')) throw drillRefusal('it names more than one host');
  const transport: ConnectionTransport = host.startsWith('/')
    ? 'unix-socket'
    : LOOPBACK_HOSTS.has(host.toLowerCase())
      ? 'loopback-tcp'
      : 'remote-tcp';
  return {
    transport,
    host,
    port: url.port.length === 0 ? '5432' : url.port,
    database: databaseName(connectionString),
    user: url.username.length === 0 ? null : decoded(url.username, 'the user name'),
    password: url.password.length === 0 ? null : decoded(url.password, 'the password'),
    parameters,
  };
}

function databaseIdentity(target: DrillTarget): string {
  const host = target.transport === 'remote-tcp' ? target.host.toLowerCase() : 'local-postgres';
  return `${host}\u0000${target.port}\u0000${target.database}`;
}

/**
 * Refuses any target that could plausibly be production. The drill may read a
 * remote source, but restores only to a separately named local database. Both
 * URLs are read once, by `drillTarget`, so the host checked is the host every
 * client of the drill connects to.
 */
export function assertRestoreDrillSafety(
  sourceConnectionString: string,
  restoreConnectionString: string,
): void {
  const source = drillTarget(sourceConnectionString);
  const target = drillTarget(restoreConnectionString);
  if (target.transport === 'remote-tcp') {
    throw new DatabaseError(
      'configuration',
      'restore target rejected: only loopback TCP or a local Unix socket is allowed',
    );
  }
  if (!RESTORE_DATABASE_NAME.test(target.database)) {
    throw new DatabaseError(
      'configuration',
      'restore target rejected: database name must begin with cas_restore_',
    );
  }
  if (databaseIdentity(source) === databaseIdentity(target)) {
    throw new DatabaseError(
      'configuration',
      'restore target rejected: source and target identify the same database',
    );
  }
}

/**
 * Variables a child tool keeps from the drill's own environment: enough to
 * find the tool, read the user's password file and format messages. Every
 * other variable, and every libpq variable above all (`PGHOSTADDR`,
 * `PGSERVICE`, `PGSERVICEFILE`, `PGSYSCONFDIR`, `PGPASSFILE`), is left out, so
 * nothing inherited can send a tool anywhere but the target.
 */
const KEPT_VARIABLES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TMPDIR',
];

const PARAMETER_VARIABLES: ReadonlyArray<readonly [string, string]> = [
  ['application_name', 'PGAPPNAME'],
  ['channel_binding', 'PGCHANNELBINDING'],
  ['connect_timeout', 'PGCONNECT_TIMEOUT'],
  ['sslcert', 'PGSSLCERT'],
  ['sslcrl', 'PGSSLCRL'],
  ['sslkey', 'PGSSLKEY'],
  ['sslrootcert', 'PGSSLROOTCERT'],
  ['target_session_attrs', 'PGTARGETSESSIONATTRS'],
];

/** The environment `pg_dump` and `pg_restore` run with: the target, and nothing inherited that routes. */
export function drillChildEnvironment(
  target: DrillTarget,
  readOnly: boolean,
  inherited: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of KEPT_VARIABLES) {
    const value = inherited[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.PGHOST = target.host;
  environment.PGPORT = target.port;
  environment.PGDATABASE = target.database;
  if (target.user !== null) environment.PGUSER = target.user;
  if (target.password !== null) environment.PGPASSWORD = target.password;
  const sslmode = target.parameters.get('sslmode');
  if (sslmode !== undefined) environment.PGSSLMODE = sslmode;
  else if (target.parameters.get('ssl') === 'true') environment.PGSSLMODE = 'require';
  for (const [parameter, variable] of PARAMETER_VARIABLES) {
    const value = target.parameters.get(parameter);
    if (value !== undefined) environment[variable] = value;
  }
  const options = [
    target.parameters.get('options'),
    readOnly ? '-c default_transaction_read_only=on' : undefined,
  ].filter((value): value is string => value !== undefined && value.length > 0);
  if (options.length > 0) environment.PGOPTIONS = options.join(' ');
  return environment;
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
