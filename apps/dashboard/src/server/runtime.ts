import 'server-only';

import type { Database } from '@cas/database';

import { SessionService, type SessionServiceOptions } from './auth/session.ts';
import type { Stores } from './auth/store.ts';
import { openStores } from './auth/stores.ts';
import { loadDashboardConfig, type DashboardConfig } from './config.ts';
import { workspace } from './packages.ts';

/**
 * The process-wide composition root: configuration, stores, the session
 * service and the read-side database handle, created once and shared.
 *
 * Tests never call `getRuntime`; they build a `Runtime` with `createRuntime`
 * from their own stores and a database handle of their choosing, which is
 * how the data-access layer's authorization checks are proven without a
 * database at all.
 */
export interface Runtime {
  readonly config: DashboardConfig;
  readonly stores: Stores;
  readonly sessions: SessionService;
  readonly database: Database;
}

export function createRuntime(
  config: DashboardConfig,
  stores: Stores,
  database: Database,
  options: SessionServiceOptions = {},
): Runtime {
  return { config, stores, sessions: new SessionService(stores, options), database };
}

/**
 * The singleton lives on `globalThis` under a registered symbol rather than in
 * module scope. Next compiles server components, server actions and route
 * handlers as separate module graphs, so a module-scoped variable would give
 * each graph its own stores: a session issued by the sign-in action would be
 * unknown to `/api/me`. One process, one runtime.
 */
const HOLDER = Symbol.for('cas.dashboard.runtime');

interface RuntimeHolder {
  shared: Promise<Runtime> | null;
}

function holder(): RuntimeHolder {
  const globals = globalThis as unknown as Record<symbol, RuntimeHolder | undefined>;
  const existing = globals[HOLDER];
  if (existing !== undefined) return existing;
  const created: RuntimeHolder = { shared: null };
  globals[HOLDER] = created;
  return created;
}

export function getRuntime(): Promise<Runtime> {
  const state = holder();
  if (state.shared === null) {
    state.shared = (async () => {
      const config = loadDashboardConfig(process.env);
      const { database: databasePackage } = await workspace();
      const database = databasePackage.openDatabase(
        databasePackage.parseDatabaseConfig(process.env, { schema: config.databaseSchema }),
        { maxConnections: 4 },
      );
      const stores = await openStores(config, database);
      return createRuntime(config, stores, database);
    })();
    // A failed start is not cached: the next request tries again and reports
    // the same fixed configuration error rather than a stale one.
    state.shared.catch(() => {
      state.shared = null;
    });
  }
  return state.shared;
}
