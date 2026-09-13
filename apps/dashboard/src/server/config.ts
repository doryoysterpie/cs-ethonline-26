import 'server-only';

import { ENVIRONMENTS, ENVIRONMENT_VARIABLE, type DashboardEnvironment } from './environment.ts';
import { DashboardError } from './errors.ts';

/**
 * Dashboard runtime configuration, read from the environment once and
 * validated as a closed set of values. A rejection names the rule that
 * failed and never the value.
 *
 * `DASHBOARD_ENVIRONMENT` is the one knob that changes browser-facing
 * behaviour: `local` omits the cookie `Secure` attribute and HSTS so the app
 * runs over plain HTTP on a developer's machine; `production` requires both.
 * There is no third value.
 *
 * `DASHBOARD_ACCOUNT_STORE` selects where accounts, sessions, audit events,
 * draft revisions and queue decisions live. `memory` is permitted only in the
 * `local` environment and exists for development and tests. `postgres`
 * (migration 0010) is production's store, and production requires it: the
 * memory store can never be selected outside `local`, and the PostgreSQL
 * store fails closed rather than falling back when no database handle is
 * available to it.
 */

export { ENVIRONMENTS, ENVIRONMENT_VARIABLE, type DashboardEnvironment } from './environment.ts';

export const ACCOUNT_STORES = ['memory', 'postgres'] as const;
export type AccountStoreKind = (typeof ACCOUNT_STORES)[number];

export interface DashboardConfig {
  readonly environment: DashboardEnvironment;
  readonly accountStore: AccountStoreKind;
  /** Path of the memory store's seed file; required with the memory store. */
  readonly memorySeedPath: string | null;
  /** The application schema the read side addresses; `public` by default. */
  readonly databaseSchema: string;
  /**
   * Whether the first `X-Forwarded-For` hop may be used as the network key for
   * login throttling. False unless a trusted reverse proxy sets the header;
   * with it false the network key is `direct`.
   */
  readonly trustForwardedFor: boolean;
}

export const ACCOUNT_STORE_VARIABLE = 'DASHBOARD_ACCOUNT_STORE';

/** The read side's default schema, the same value `@cas/database` defaults to. */
export const DEFAULT_APPLICATION_SCHEMA = 'public';
/**
 * The same shape `@cas/database` accepts in `assertSchemaName`. Checked here so
 * configuration fails before any package loads; the runtime passes the value
 * through `parseDatabaseConfig`, which applies the package's own check again.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
export const MEMORY_SEED_VARIABLE = 'DASHBOARD_MEMORY_STORE_SEED';
export const DATABASE_SCHEMA_VARIABLE = 'DASHBOARD_DATABASE_SCHEMA';
export const TRUST_FORWARDED_FOR_VARIABLE = 'DASHBOARD_TRUST_FORWARDED_FOR';

function configuration(code: string, message: string): DashboardError {
  return new DashboardError('configuration', code, message);
}

function read(env: Readonly<Record<string, string | undefined>>, name: string): string | null {
  const value = env[name];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function loadDashboardConfig(
  env: Readonly<Record<string, string | undefined>>,
): DashboardConfig {
  const environment = read(env, ENVIRONMENT_VARIABLE);
  if (environment === null) {
    throw configuration('environment_missing', `${ENVIRONMENT_VARIABLE} is not set`);
  }
  if (!(ENVIRONMENTS as readonly string[]).includes(environment)) {
    throw configuration(
      'environment_invalid',
      `${ENVIRONMENT_VARIABLE} rejected: must be local or production`,
    );
  }

  const accountStore = read(env, ACCOUNT_STORE_VARIABLE);
  if (accountStore === null) {
    throw configuration('account_store_missing', `${ACCOUNT_STORE_VARIABLE} is not set`);
  }
  if (!(ACCOUNT_STORES as readonly string[]).includes(accountStore)) {
    throw configuration(
      'account_store_invalid',
      `${ACCOUNT_STORE_VARIABLE} rejected: must be memory or postgres`,
    );
  }
  if (accountStore === 'memory' && environment !== 'local') {
    throw configuration(
      'memory_store_outside_local',
      `${ACCOUNT_STORE_VARIABLE} rejected: the memory store is permitted only when ${ENVIRONMENT_VARIABLE} is local`,
    );
  }

  const memorySeedPath = read(env, MEMORY_SEED_VARIABLE);
  if (accountStore === 'memory' && memorySeedPath === null) {
    throw configuration('memory_seed_missing', `${MEMORY_SEED_VARIABLE} is not set`);
  }
  if (accountStore !== 'memory' && memorySeedPath !== null) {
    throw configuration(
      'memory_seed_unexpected',
      `${MEMORY_SEED_VARIABLE} rejected: set only with the memory store`,
    );
  }

  const databaseSchema = read(env, DATABASE_SCHEMA_VARIABLE) ?? DEFAULT_APPLICATION_SCHEMA;
  if (!SCHEMA_NAME.test(databaseSchema)) {
    throw configuration(
      'database_schema_invalid',
      `${DATABASE_SCHEMA_VARIABLE} rejected: not a plain identifier`,
    );
  }

  const trust = read(env, TRUST_FORWARDED_FOR_VARIABLE);
  if (trust !== null && trust !== 'true' && trust !== 'false') {
    throw configuration(
      'trust_forwarded_for_invalid',
      `${TRUST_FORWARDED_FOR_VARIABLE} rejected: must be true or false`,
    );
  }

  return {
    environment: environment as DashboardEnvironment,
    accountStore: accountStore as AccountStoreKind,
    memorySeedPath,
    databaseSchema,
    trustForwardedFor: trust === 'true',
  };
}
