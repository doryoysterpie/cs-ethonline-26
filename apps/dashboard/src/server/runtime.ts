import 'server-only';

import type { Database } from '@cas/database';

import type { EmailProvider } from './auth/email-provider.ts';
import { loadOtpEmailConfig, type OtpEmailConfig } from './auth/email-config.ts';
import { SessionService, type SessionServiceOptions } from './auth/session.ts';
import type { Stores } from './auth/store.ts';
import { openStores } from './auth/stores.ts';
import type { RoundupTransport } from '@cas/roundup';

import { loadDashboardConfig, type DashboardConfig } from './config.ts';
import { ReadingCache } from './dal/readings.ts';
import { createAnthropicTransport } from './model/anthropic.ts';
import { loadModelConfig } from './model/config.ts';
import { createNodeReader, loadReaderConfig, type SourceReaderDeps } from './model/reader.ts';
import { defaultLimits, type Limits } from './http/limits.ts';
import { workspace } from './packages.ts';

/**
 * The memory store is already restricted to `local` by `loadDashboardConfig`
 * (development and tests, never production); this is the same restriction
 * applied to email delivery, so a developer or a test does not also need a
 * real Resend key and a real pepper just to load the runtime. The provider
 * is never called for real work while this branch is active: production
 * always uses the PostgreSQL store, which always requires `loadOtpEmailConfig`.
 */
function localOtpEmailConfig(): OtpEmailConfig {
  const provider: EmailProvider = { send: async () => undefined };
  return { provider, pepper: 'local-development-pepper-not-a-production-secret' };
}

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
  /** The one boundary to a model; null when no credential is configured, so generation fails closed. */
  readonly model: RoundupTransport | null;
  /** The source-reading boundary (CAS-005); null when the dashboard's public address is not configured. */
  readonly reader: SourceReaderDeps | null;
  /** The pending readings, in memory for ten minutes (O-1, R17). */
  readonly readings: ReadingCache;
  /** The email provider the sign-up flow writes through (CAS-007); null when none is configured. */
  readonly email: EmailProvider | null;
  /** The pepper the sign-up code digest uses, the same one sign-in uses; null when none is configured. */
  readonly otpPepper: string | null;
  /** The fixed-window limits of CAS-007. */
  readonly limits: Limits;
}

export function createRuntime(
  config: DashboardConfig,
  stores: Stores,
  database: Database,
  options: SessionServiceOptions & {
    readonly model?: RoundupTransport | null | undefined;
    readonly reader?: SourceReaderDeps | null | undefined;
    readonly readings?: ReadingCache | undefined;
    readonly limits?: Limits | undefined;
  } = {},
): Runtime {
  const { model, reader, readings, limits, ...sessionOptions } = options;
  return {
    config,
    stores,
    sessions: new SessionService(stores, sessionOptions),
    database,
    model: model ?? null,
    reader: reader ?? null,
    readings: readings ?? new ReadingCache(),
    email: sessionOptions.emailProvider ?? null,
    otpPepper: sessionOptions.otpPepper ?? null,
    limits: limits ?? defaultLimits(),
  };
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
      const { database: databasePackage, sourceReader } = await workspace();
      const database = databasePackage.openDatabase(
        databasePackage.parseDatabaseConfig(process.env, { schema: config.databaseSchema }),
        { maxConnections: 4 },
      );
      const stores = await openStores(config, database);
      const otp =
        config.accountStore === 'memory' ? localOtpEmailConfig() : loadOtpEmailConfig(process.env);
      const modelConfig = loadModelConfig(process.env);
      const readerConfig = loadReaderConfig(process.env);
      return createRuntime(config, stores, database, {
        emailProvider: otp.provider,
        otpPepper: otp.pepper,
        model: modelConfig === null ? null : createAnthropicTransport(modelConfig),
        reader: readerConfig === null ? null : createNodeReader(readerConfig, sourceReader),
      });
    })();
    // A failed start is not cached: the next request tries again and reports
    // the same fixed configuration error rather than a stale one.
    state.shared.catch(() => {
      state.shared = null;
    });
  }
  return state.shared;
}
