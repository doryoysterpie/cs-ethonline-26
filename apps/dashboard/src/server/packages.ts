import 'server-only';

import type * as DatabaseModule from '@cas/database';
import type * as WorkerModule from '@cas/worker';

/**
 * Runtime loading of the two Node-only workspace packages.
 *
 * Next bundles every module whose real path lies outside a `node_modules`
 * directory, and `serverExternalPackages` cannot change that for a pnpm
 * workspace link. `@cas/database` locates its migration directory from
 * `import.meta.url`, which a bundler cannot preserve, and `@cas/worker`
 * depends on it. Both are therefore imported here with the bundler-ignore
 * markers, so Node resolves them at run time from the application's own
 * `node_modules` exactly as the worker's command line does. The packages
 * themselves are untouched.
 *
 * The type imports above are erased at compile time; only the dynamic
 * imports below execute. Loaded once per process.
 */
export interface WorkspacePackages {
  readonly database: typeof DatabaseModule;
  readonly worker: typeof WorkerModule;
}

let loaded: Promise<WorkspacePackages> | null = null;

export function workspace(): Promise<WorkspacePackages> {
  if (loaded === null) {
    loaded = Promise.all([
      import(/* turbopackIgnore: true */ /* webpackIgnore: true */ '@cas/database'),
      import(/* turbopackIgnore: true */ /* webpackIgnore: true */ '@cas/worker'),
    ]).then(([database, worker]) => ({ database, worker }));
    loaded.catch(() => {
      loaded = null;
    });
  }
  return loaded;
}
