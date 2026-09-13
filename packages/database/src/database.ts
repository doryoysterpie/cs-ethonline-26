import pg from 'pg';

import { assertSchemaName, DEFAULT_APPLICATION_SCHEMA, type DatabaseConfig } from './config.js';
import { classifyDriverError, DatabaseError } from './errors.js';
import { connectionSecrets, createRedactor, type Redactor } from './redact.js';

/**
 * The only PostgreSQL client in the workspace (docs/ARCHITECTURE.md section
 * 2). Wraps a `pg.Pool`: every query is parameterized by the caller, every
 * driver error is classified into a `DatabaseError` with a fixed message, and
 * a transaction is either committed or rolled back before its client returns
 * to the pool. Session time zone is UTC.
 */

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export interface DatabaseOptions {
  readonly maxConnections?: number | undefined;
  /**
   * How a pooled client is acquired. Defaults to the pool's own `connect`.
   *
   * The only supported non-default use is a test that must exercise the
   * connection-failure boundary without opening a socket. Sprint 4's attempt
   * at that pointed a connection string at a closed loopback port, which made
   * the default suite depend on a socket and fail wherever sockets are denied
   * (audit finding F5). Injecting the driver's failure here keeps the real
   * pool, the real error classification and the real redaction in the path and
   * removes only the network.
   */
  readonly connect?: (() => Promise<pg.PoolClient>) | undefined;
}

/** Only the levels this project uses are offered, so a typo cannot widen a snapshot. */
export type IsolationLevel = 'repeatable read';

export interface TransactionOptions {
  readonly isolationLevel?: IsolationLevel | undefined;
}

function wrap(client: pg.PoolClient): Queryable {
  return {
    async query<R extends pg.QueryResultRow>(text: string, values?: readonly unknown[]) {
      try {
        return await client.query<R>(text, values === undefined ? undefined : [...values]);
      } catch (error) {
        throw classifyDriverError(error);
      }
    },
  };
}

export class Database {
  readonly redact: Redactor;
  /**
   * The one schema this handle addresses. Never null: an unspecified schema
   * resolves to `public`, never to a role-controlled default.
   */
  readonly schema: string;
  private readonly pool: pg.Pool;
  private readonly connect: () => Promise<pg.PoolClient>;
  private ended = false;

  constructor(config: DatabaseConfig, options: DatabaseOptions = {}) {
    const schema = config.schema ?? DEFAULT_APPLICATION_SCHEMA;
    // Validated as a plain lowercase identifier before it reaches a startup
    // parameter or an interpolated identifier anywhere in the package.
    assertSchemaName(schema);
    this.schema = schema;
    this.redact = createRedactor(connectionSecrets(config.connectionString));
    // The search path is always exactly one application schema followed by
    // `pg_temp`. Codex Desktop's re-audit showed why: with no explicit path
    // PostgreSQL uses `"$user", public`, so a role that can create a schema
    // named after itself silently captures every unqualified relation, and
    // with `pg_temp` unlisted PostgreSQL searches the session's temporary
    // schema first. Naming `pg_temp` last puts it after the application
    // schema instead of before it, and omitting `$user` removes the capture.
    const startupOptions = ['-c TimeZone=UTC', `-c search_path=${schema},pg_temp`];
    this.pool = new pg.Pool({
      connectionString: config.connectionString,
      max: options.maxConnections ?? 4,
      application_name: 'cas-database',
      options: startupOptions.join(' '),
    });
    // An idle client can drop its connection; without a listener the pool
    // would raise it as an uncaught error. Nothing is logged here because a
    // driver message may carry connection details.
    this.pool.on('error', () => undefined);
    this.connect = options.connect ?? ((): Promise<pg.PoolClient> => this.pool.connect());
  }

  private async acquire(): Promise<pg.PoolClient> {
    if (this.ended) throw new DatabaseError('connection', 'database handle already closed');
    try {
      return await this.connect();
    } catch (error) {
      throw classifyDriverError(error);
    }
  }

  async withClient<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.acquire();
    try {
      return await fn(wrap(client));
    } finally {
      client.release();
    }
  }

  /**
   * Runs `fn` inside one transaction. Commits when it resolves; rolls back
   * when it throws, then rethrows the original error. If the rollback itself
   * fails the client is destroyed instead of returned to the pool.
   *
   * `isolationLevel` is set on the BEGIN itself, before any other statement,
   * so the transaction's snapshot is fixed from its first query. Classification
   * uses `repeatable read` so that paging a batch cannot observe a concurrent
   * change halfway through; every other caller keeps PostgreSQL's default.
   */
  async withTransaction<T>(
    fn: (tx: Queryable) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const client = await this.acquire();
    const tx = wrap(client);
    let destroy = false;
    try {
      await tx.query(
        options.isolationLevel === 'repeatable read'
          ? 'BEGIN ISOLATION LEVEL REPEATABLE READ'
          : 'BEGIN',
      );
      const result = await fn(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroy = true;
      }
      // Driver errors were classified by the wrapper; the caller's own errors
      // pass through unchanged so their kind is preserved.
      throw error;
    } finally {
      client.release(destroy);
    }
  }

  async serverVersion(): Promise<string> {
    return this.withClient(async (client) => {
      const result = await client.query<{ version: string }>(
        "SELECT current_setting('server_version') AS version",
      );
      return result.rows[0]?.version ?? 'unknown';
    });
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.pool.end();
  }
}

export function openDatabase(config: DatabaseConfig, options: DatabaseOptions = {}): Database {
  return new Database(config, options);
}
