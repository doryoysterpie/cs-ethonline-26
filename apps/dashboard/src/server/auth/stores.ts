import 'server-only';

import type { Database } from '@cas/database';

import type { DashboardConfig } from '../config.ts';
import { DashboardError } from '../errors.ts';
import { openMemoryStores } from './memory-store.ts';
import { openPostgresStores } from './postgres-store.ts';
import type { Stores } from './store.ts';

/**
 * Store selection.
 *
 * `memory` needs nothing further: it is refused outside the `local`
 * environment by `loadDashboardConfig`. `postgres` (migration 0010) opens
 * over the caller's own database handle, so this function never opens a
 * connection of its own and never falls back: a `postgres` selection with no
 * handle, or a handle that cannot reach the database, fails closed rather
 * than serving a request no account exists to answer.
 */
export async function openStores(config: DashboardConfig, database?: Database): Promise<Stores> {
  if (config.accountStore === 'memory') {
    return openMemoryStores(config.memorySeedPath);
  }
  if (database === undefined) {
    throw new DashboardError(
      'configuration',
      'postgres_store_requires_database',
      'the PostgreSQL store requires an open database handle',
    );
  }
  return openPostgresStores(database);
}
