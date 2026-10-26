import 'server-only';

import type { Database } from '@cas/database';

import type { EmailProvider } from './auth/email-provider.ts';
import type { OtpEmailConfig } from './auth/email-config.ts';
import { LOCAL_EMAIL_FILE_VARIABLE, localEmailProvider } from './auth/local-email.ts';
import { SessionService, type SessionServiceOptions } from './auth/session.ts';
import type { Stores } from './auth/store.ts';
import { openStores } from './auth/stores.ts';
import type { RoundupTransport } from '@cas/roundup';

import { loadDashboardRuntimeConfig, type DashboardConfig } from './config.ts';
import { ReadingCache } from './dal/readings.ts';
import { createAnthropicTransport } from './model/anthropic.ts';
import { createNodeReader, type SourceReaderDeps } from './model/reader.ts';
import { defaultLimits, type Limits } from './http/limits.ts';
import type { StripeMode } from './support/config.ts';
import { createStripeClient, type StripeClient } from './support/stripe.ts';
import { workspace } from './packages.ts';

/**
 * The memory store is already restricted to `local` by the runtime config
 * (development and tests, never production); this is the same restriction
 * applied to email delivery, so a developer or a test does not also need a
 * real Resend key and a real pepper just to load the runtime. The provider
 * writes each message to the local file the developer names, or drops it
 * when none is named (CAS-010); production always uses the PostgreSQL store,
 * whose aggregate configuration always requires real email delivery.
 */
function localOtpEmailConfig(env: Readonly<Record<string, string | undefined>>): OtpEmailConfig {
  const file = env[LOCAL_EMAIL_FILE_VARIABLE]?.trim();
  const provider: EmailProvider = localEmailProvider(
    file === undefined || file.length === 0 ? null : file,
  );
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
  /** The dashboard's public https origin (DASHBOARD_PUBLIC_URL), named in the approval email; null when unset. */
  readonly publicUrl: string | null;
  /** The supporter tier's provider boundary (CAS-008); null when not configured, so every support action fails closed. */
  readonly support: SupportDeps | null;
}

export interface SupportDeps {
  readonly stripe: StripeClient;
  readonly webhookSecret: string;
  readonly priceId: string;
  readonly mode: StripeMode;
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
    readonly publicUrl?: string | null | undefined;
    readonly support?: SupportDeps | null | undefined;
  } = {},
): Runtime {
  const { model, reader, readings, limits, publicUrl, support, ...sessionOptions } = options;
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
    publicUrl: publicUrl ?? null,
    support: support ?? null,
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
      const loadedConfig = loadDashboardRuntimeConfig(process.env);
      const config = loadedConfig.dashboard;
      const { database: databasePackage, sourceReader } = await workspace();
      const database = databasePackage.openDatabase(
        databasePackage.parseDatabaseConfig(process.env, { schema: config.databaseSchema }),
        { maxConnections: 4 },
      );
      const stores = await openStores(config, database);
      const otp = loadedConfig.otpEmail ?? localOtpEmailConfig(process.env);
      const modelConfig = loadedConfig.model;
      const readerConfig = loadedConfig.reader;
      const supportConfig = loadedConfig.support;
      return createRuntime(config, stores, database, {
        emailProvider: otp.provider,
        otpPepper: otp.pepper,
        model: modelConfig === null ? null : createAnthropicTransport(modelConfig),
        reader: readerConfig === null ? null : createNodeReader(readerConfig, sourceReader),
        publicUrl: readerConfig === null ? null : new URL(readerConfig.publicUrl).origin,
        support:
          supportConfig === null
            ? null
            : {
                stripe: createStripeClient(supportConfig, fetch),
                webhookSecret: supportConfig.webhookSecret,
                priceId: supportConfig.priceId,
                mode: supportConfig.mode,
              },
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
