import 'server-only';

import type { DashboardConfig } from '../config.ts';
import { DashboardError } from '../errors.ts';
import { openMemoryStores } from './memory-store.ts';
import type { Stores } from './store.ts';

/**
 * Store selection.
 *
 * The PostgreSQL store is not implemented in this track. Authentication
 * persistence is paused until the next migration number is allocated after the
 * Sprint 5 correction (which reserves 0009), so choosing it fails with one
 * fixed message rather than opening a connection to tables that do not exist.
 * The message is deliberate: a server that booted and silently could not sign
 * anyone in would be the failure mode this project refuses everywhere else.
 */
export const PERSISTENCE_PAUSED_MESSAGE =
  'account persistence is paused: the PostgreSQL store waits for the next migration number after the Sprint 5 correction';

export async function openStores(config: DashboardConfig): Promise<Stores> {
  if (config.accountStore === 'memory') {
    return openMemoryStores(config.memorySeedPath);
  }
  throw new DashboardError(
    'persistence_paused',
    'postgres_store_paused',
    PERSISTENCE_PAUSED_MESSAGE,
  );
}
