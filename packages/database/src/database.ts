import pg from 'pg';

import { assertSchemaName, type DatabaseConfig } from './config.js';
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
  readonly schema: string | null;
  private readonly pool: pg.Pool;
  private ended = false;

  constructor(config: DatabaseConfig, options: DatabaseOptions = {}) {
    if (config.schema !== null) assertSchemaName(config.schema);
    this.schema = config.schema;
    this.redact = createRedactor(connectionSecrets(config.connectionString));
    const startupOptions = ['-c TimeZone=UTC'];
    if (config.schema !== null) startupOptions.push(`-c search_path=${config.schema}`);
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
  }

  private async acquire(): Promise<pg.PoolClient> {
    if (this.ended) throw new DatabaseError('connection', 'database handle already closed');
    try {
      return await this.pool.connect();
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
   */
  async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.acquire();
    const tx = wrap(client);
    let destroy = false;
    try {
      await tx.query('BEGIN');
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
