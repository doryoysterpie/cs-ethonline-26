import { DatabaseError } from './errors.js';

/**
 * Connection configuration. The connection string is read from
 * `DATABASE_URL` only, validated structurally, and never echoed: a rejected
 * value is reported by the rule that failed, not by its content.
 *
 * The credential policy is part of that validation. A passwordless URL is
 * accepted; a supplied password must percent-decode and must be at least
 * four characters once decoded, so that the redactor can always protect it
 * (see `MINIMUM_PASSWORD_LENGTH`).
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

/**
 * Shortest password this project accepts, measured after percent-decoding.
 *
 * The redactor deliberately ignores secret values shorter than four
 * characters, because such a value would match ordinary words and blank out
 * unrelated output. A password shorter than that could therefore appear in a
 * filename or a label and never be redacted. Rather than weaken the
 * redactor, the configuration refuses the credential: every password this
 * project accepts is long enough for the redactor to protect it.
 */
export const MINIMUM_PASSWORD_LENGTH = 4;

/**
 * Enforces the credential policy on a connection string:
 *
 * - a passwordless URL is valid, which keeps local development simple;
 * - a password that cannot be percent-decoded is refused, because a
 *   credential that cannot be decoded cannot be redacted reliably;
 * - a password whose decoded form is shorter than four characters is
 *   refused, because the redactor cannot protect it.
 *
 * The error names the rule only. It never carries the URL, the username, the
 * hostname, the raw password, the decoded password or any fragment of one.
 * A value that is not a PostgreSQL URL is left to `parseDatabaseConfig`,
 * which rejects it on its own terms.
 */
export function assertCredentialPolicy(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return;
  if (url.password.length === 0) return;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.password);
  } catch {
    throw new DatabaseError(
      'configuration',
      `${DATABASE_URL_VARIABLE} rejected: the database password is not valid percent-encoding`,
    );
  }
  if (decoded.length < MINIMUM_PASSWORD_LENGTH) {
    throw new DatabaseError(
      'configuration',
      `${DATABASE_URL_VARIABLE} rejected: the database password must be at least ${MINIMUM_PASSWORD_LENGTH} characters after percent-decoding`,
    );
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
  // Every database entry point reaches this function: migration, check,
  // import and report all build their handle from it.
  assertCredentialPolicy(connectionString);
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
