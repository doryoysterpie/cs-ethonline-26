import 'server-only';

import type * as ArticleModule from '@cas/article';
import type * as DatabaseModule from '@cas/database';
import type * as RoundupModule from '@cas/roundup';
import type * as SourceReaderModule from '@cas/source-reader';
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
  /** Resolves its template from `import.meta.url`, so it loads the same way. */
  readonly roundup: typeof RoundupModule;
  /** The source-reading boundary (CAS-005): its one transport names Node's HTTP clients. */
  readonly sourceReader: typeof SourceReaderModule;
  /** The article contract (CAS-005), loaded beside the reader it is fed by. */
  readonly article: typeof ArticleModule;
}

let loaded: Promise<WorkspacePackages> | null = null;

export function workspace(): Promise<WorkspacePackages> {
  if (loaded === null) {
    loaded = Promise.all([
      import(/* turbopackIgnore: true */ /* webpackIgnore: true */ '@cas/database'),
      import(/* turbopackIgnore: true */ /* webpackIgnore: true */ '@cas/worker'),
      import(/* turbopackIgnore: true */ /* webpackIgnore: true */ '@cas/roundup'),
      import(/* turbopackIgnore: true */ /* webpackIgnore: true */ '@cas/source-reader'),
      import(/* turbopackIgnore: true */ /* webpackIgnore: true */ '@cas/article'),
    ]).then(([database, worker, roundup, sourceReader, article]) => ({
      database,
      worker,
      roundup,
      sourceReader,
      article,
    }));
    loaded.catch(() => {
      loaded = null;
    });
  }
  return loaded;
}
