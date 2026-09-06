import { DatabaseError } from './errors.js';

/**
 * Connection configuration. The connection string is read from
 * `DATABASE_URL` only, validated structurally, and never echoed: a rejected
 * value is reported by the rule that failed, not by its content.
 */

export const DATABASE_URL_VARIABLE = 'DATABASE_URL';

export interface DatabaseConfig {
  readonly connectionString: string;
  /** Optional schema placed first on `search_path`; used by isolated test schemas. */
  readonly schema: string | null;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Accepts only a plain lowercase identifier, so it can be quoted safely as an identifier. */
export function assertSchemaName(name: string): void {
  if (!SCHEMA_NAME.test(name)) {
    throw new DatabaseError('configuration', 'schema name rejected: not a plain identifier');
  }
}

export function parseDatabaseConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly schema?: string | null | undefined } = {},
): DatabaseConfig {
  const raw = env[DATABASE_URL_VARIABLE];
  if (raw === undefined || raw.trim().length === 0) {
    throw new DatabaseError('configuration', `${DATABASE_URL_VARIABLE} is not set`);
  }
  const connectionString = raw.trim();
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new DatabaseError('configuration', `${DATABASE_URL_VARIABLE} rejected: not a URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new DatabaseError(
      'configuration',
      `${DATABASE_URL_VARIABLE} rejected: scheme must be postgres or postgresql`,
    );
  }
  const schema = options.schema ?? null;
  if (schema !== null) assertSchemaName(schema);
  return { connectionString, schema };
}

export type ConnectionTransport = 'unix-socket' | 'loopback-tcp' | 'remote-tcp';

/** Content-free description of how a connection string connects. */
export interface ConnectionSummary {
  readonly transport: ConnectionTransport;
  readonly passwordPresent: boolean;
  readonly sslRequested: boolean;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function summarizeConnection(connectionString: string): ConnectionSummary {
  const url = new URL(connectionString);
  const hostParameter = url.searchParams.get('host');
  const socket =
    (hostParameter !== null && hostParameter.startsWith('/')) ||
    url.hostname.startsWith('%2F') ||
    url.hostname.startsWith('/') ||
    (url.hostname.length === 0 && hostParameter === null);
  const transport: ConnectionTransport = socket
    ? 'unix-socket'
    : LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
      ? 'loopback-tcp'
      : 'remote-tcp';
  const sslmode = url.searchParams.get('sslmode');
  const sslRequested =
    (sslmode !== null && sslmode !== 'disable') || url.searchParams.get('ssl') === 'true';
  return { transport, passwordPresent: url.password.length > 0, sslRequested };
}
