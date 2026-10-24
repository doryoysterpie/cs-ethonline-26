import type { DatabaseConfig, DatabaseReadinessOptions } from '@cas/database';

import { loadDashboardRuntimeConfig, READINESS_TIMEOUT_MILLIS } from '../../../server/config.ts';
import { NO_STORE } from '../../../server/http/headers.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface ReadinessDatabase {
  readonly parseDatabaseConfig: (
    env: Readonly<Record<string, string | undefined>>,
    options?: { readonly schema?: string | null | undefined },
  ) => DatabaseConfig;
  readonly probeDatabaseReadiness: (
    config: DatabaseConfig,
    options: DatabaseReadinessOptions,
  ) => Promise<void>;
}

export interface ReadinessDependencies {
  readonly loadDatabase: () => Promise<ReadinessDatabase>;
}

const dependencies: ReadinessDependencies = {
  loadDatabase: () => import(/* turbopackIgnore: true */ /* webpackIgnore: true */ '@cas/database'),
};

async function checkReadiness(
  env: Readonly<Record<string, string | undefined>>,
  deps: ReadinessDependencies,
): Promise<void> {
  const runtimeConfig = loadDashboardRuntimeConfig(env);
  const database = await deps.loadDatabase();
  const databaseConfig = database.parseDatabaseConfig(env, {
    schema: runtimeConfig.dashboard.databaseSchema,
  });
  await database.probeDatabaseReadiness(databaseConfig, {
    timeoutMillis: READINESS_TIMEOUT_MILLIS,
  });
}

function response(status: 200 | 503): Response {
  return new Response(null, { status, headers: { 'Cache-Control': NO_STORE } });
}

/** Testable boundary with the same empty, secret-free response as the route. */
export async function readinessResponse(
  env: Readonly<Record<string, string | undefined>>,
  deps: ReadinessDependencies = dependencies,
): Promise<Response> {
  try {
    await checkReadiness(env, deps);
    return response(200);
  } catch {
    return response(503);
  }
}

let activeCheck: Promise<void> | null = null;

/**
 * Deployment readiness. Concurrent callers share one bounded probe, so an
 * aggressive platform checker still opens at most one readiness connection.
 * Failures are deliberately silent and content-free: provider state,
 * connection details, versions and migration state never cross this route.
 */
export async function GET(): Promise<Response> {
  if (activeCheck === null) {
    const started = checkReadiness(process.env, dependencies);
    activeCheck = started;
    void started.then(
      () => {
        if (activeCheck === started) activeCheck = null;
      },
      () => {
        if (activeCheck === started) activeCheck = null;
      },
    );
  }
  try {
    await activeCheck;
    return response(200);
  } catch {
    return response(503);
  }
}
