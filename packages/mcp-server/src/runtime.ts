import { DATABASE_URL_VARIABLE, parseDatabaseConfig } from '@cas/database';

import {
  LIVE_TOOL_DEADLINE_MS,
  MAX_CONCURRENT_CALLS,
  RATE_LIMIT_CALLS,
  RATE_LIMIT_WINDOW_MS,
  RESULT_MAX_BYTES,
  STORED_TOOL_DEADLINE_MS,
} from './bounds.js';
import { TOOL_DEFINITIONS, isToolName, type ToolName } from './definitions.js';
import { evidenceContractLabeller, type AnomalyLabeller } from './engines/anomaly.js';
import { deterministicPreviewer, type DraftPreviewer } from './engines/draft.js';
import { GraphLiveSignalSource, type LiveSignalSource } from './engines/live-graph.js';
import { ToolError, toToolError, type SafeDetail, type ToolErrorCode } from './safety/errors.js';
import { connectionSecrets, createRedactor, redactDeep, type Redactor } from './safety/redact.js';
import { toSingleLine } from './safety/text.js';
import {
  PostgresReadStoreProvider,
  textFetchMargin,
  type StoreMode,
} from './store/postgres-store.js';
import type { PrivilegeCheck } from './store/privileges.js';
import type { IncidentReadStoreProvider } from './store/read-store.js';
import { chainAnomalies } from './tools/chain-anomalies.js';
import { draftSection } from './tools/draft-section.js';
import { explainIncident } from './tools/explain-incident.js';
import { listIncidents } from './tools/list-incidents.js';
import type { ToolContext } from './tools/shared.js';
import { validateArguments } from './validation.js';

/**
 * The tool runtime: what a tool may reach, and the one function that runs a
 * tool. Every call passes, in order, the name check, the rate limit, the
 * concurrency cap, the hardened argument boundary, the wall-clock deadline,
 * the output contract, the redactor and the size bound. A failure at any
 * step is a fixed-vocabulary error; nothing else leaves.
 */

/**
 * `CAS_MCP_MODE` selects the store's mode. `production`, the default when the
 * variable is absent, requires the database credential to be a dedicated
 * reader role: the privilege matrix runs at start-up and again on every
 * stored call's own connection before any application read, and an
 * overprivileged credential fails closed. `development` still runs and logs
 * the start-up check but does not refuse an overprivileged local credential.
 * Any other value is rejected at start-up.
 */
export const MODE_VARIABLE = 'CAS_MCP_MODE';
export const STORE_MODES = ['production', 'development'] as const;

/** The only environment names this server reads. Values are never emitted. */
export const ENVIRONMENT_NAMES = [
  DATABASE_URL_VARIABLE,
  'GRAPH_API_KEY',
  'GRAPH_GATEWAY_URL',
  MODE_VARIABLE,
] as const;

/** The outcome of asking the database who the configured credential is. */
export interface DatabaseRoleVerification {
  /**
   * `absent`: no database is configured. `verified`: every check passed.
   * `overprivileged`: at least one check failed. `unverified`: the database
   * could not be asked; every stored call verifies again before it reads.
   */
  readonly status: 'absent' | 'verified' | 'overprivileged' | 'unverified';
  readonly failed: readonly PrivilegeCheck[];
  readonly errorCode: ToolErrorCode | null;
}

export interface ToolRuntime {
  /** Null when `DATABASE_URL` is absent; stored tools then fail with a fixed code. */
  readonly store: IncidentReadStoreProvider | null;
  /** Null when `GRAPH_API_KEY` is absent; live mode then fails with a fixed code and no fallback. */
  readonly live: LiveSignalSource | null;
  readonly mode: StoreMode;
  readonly labeller: AnomalyLabeller;
  readonly previewer: DraftPreviewer;
  readonly redact: Redactor;
  readonly now: () => Date;
  /** Receives one redacted, single-line record per call. Never stdout. */
  readonly log: (line: string) => void;
  readonly deadlines: { readonly stored: number; readonly live: number };
  readonly limiter: CallLimiter;
  verifyDatabaseRole(): Promise<DatabaseRoleVerification>;
  close(): Promise<void>;
}

/** A sliding-window rate limit plus a concurrency cap, per process. */
export class CallLimiter {
  readonly #starts: number[] = [];
  #inFlight = 0;
  readonly #calls: number;
  readonly #windowMs: number;
  readonly #concurrent: number;
  readonly #now: () => number;

  constructor(
    options: { calls?: number; windowMs?: number; concurrent?: number; now?: () => number } = {},
  ) {
    this.#calls = options.calls ?? RATE_LIMIT_CALLS;
    this.#windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
    this.#concurrent = options.concurrent ?? MAX_CONCURRENT_CALLS;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Admits a call or throws; the returned function releases the concurrency slot. */
  admit(): () => void {
    const now = this.#now();
    while (this.#starts.length > 0 && (this.#starts[0] ?? 0) <= now - this.#windowMs) {
      this.#starts.shift();
    }
    if (this.#starts.length >= this.#calls) throw new ToolError('rate_limited');
    if (this.#inFlight >= this.#concurrent) throw new ToolError('too_many_concurrent_calls');
    this.#starts.push(now);
    this.#inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inFlight -= 1;
    };
  }
}

export interface RuntimeOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log?: ((line: string) => void) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly fetchImpl?: ConstructorParameters<typeof GraphLiveSignalSource>[0]['fetchImpl'];
  readonly store?: IncidentReadStoreProvider | null | undefined;
  readonly live?: LiveSignalSource | null | undefined;
  /** Overrides `CAS_MCP_MODE`. */
  readonly mode?: StoreMode | undefined;
  readonly labeller?: AnomalyLabeller | undefined;
  readonly previewer?: DraftPreviewer | undefined;
  readonly deadlines?: { readonly stored: number; readonly live: number } | undefined;
  readonly limiter?: CallLimiter | undefined;
}

function present(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

/** Parses the mode variable. The rejected value is never echoed. */
export function parseStoreMode(value: string | undefined): StoreMode {
  const trimmed = present(value);
  if (trimmed === undefined) return 'production';
  if ((STORE_MODES as readonly string[]).includes(trimmed)) return trimmed as StoreMode;
  throw new Error(`${MODE_VARIABLE} rejected: must be one of ${STORE_MODES.join(', ')}`);
}

/**
 * Builds a runtime from the allowlisted environment names. A configured
 * `DATABASE_URL` is validated in full before anything else, so a rejected
 * value stops the server rather than reaching a redactor-less path; an absent
 * one leaves the store null. `GRAPH_API_KEY` constructs the live client, whose
 * own validation rejects a bad gateway URL before any request. The store's
 * sentinel margin is sized from the secrets the redactor holds, so a secret
 * that begins inside a displayed prefix is always fetched whole.
 */
export function createRuntime(options: RuntimeOptions): ToolRuntime {
  const databaseUrl = present(options.env[DATABASE_URL_VARIABLE]);
  const apiKey = present(options.env['GRAPH_API_KEY']);
  const gatewayBaseUrl = present(options.env['GRAPH_GATEWAY_URL']);
  const mode = options.mode ?? parseStoreMode(options.env[MODE_VARIABLE]);
  const secrets = [...connectionSecrets(databaseUrl), apiKey].filter(
    (secret): secret is string => typeof secret === 'string',
  );
  const redact = createRedactor(secrets);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const safeLog = (line: string): void => log(toSingleLine(redact(line)));

  let store: IncidentReadStoreProvider | null;
  if (options.store !== undefined) {
    store = options.store;
  } else if (databaseUrl === undefined) {
    store = null;
  } else {
    store = new PostgresReadStoreProvider(parseDatabaseConfig(options.env), {
      mode,
      textFetchMargin: textFetchMargin(secrets.map((secret) => secret.length)),
    });
  }

  let live: LiveSignalSource | null;
  if (options.live !== undefined) {
    live = options.live;
  } else if (apiKey === undefined) {
    live = null;
  } else {
    live = new GraphLiveSignalSource({
      apiKey,
      gatewayBaseUrl,
      fetchImpl: options.fetchImpl,
      now: options.now,
    });
  }

  return {
    store,
    live,
    mode,
    labeller: options.labeller ?? evidenceContractLabeller,
    previewer: options.previewer ?? deterministicPreviewer,
    redact,
    now: options.now ?? (() => new Date()),
    log: safeLog,
    deadlines: options.deadlines ?? {
      stored: STORED_TOOL_DEADLINE_MS,
      live: LIVE_TOOL_DEADLINE_MS,
    },
    limiter: options.limiter ?? new CallLimiter(),
    async verifyDatabaseRole() {
      if (store === null) return { status: 'absent', failed: [], errorCode: null };
      try {
        const report = await store.verifyPrivileges();
        return report.ok
          ? { status: 'verified', failed: [], errorCode: null }
          : { status: 'overprivileged', failed: report.failed, errorCode: null };
      } catch (error) {
        return { status: 'unverified', failed: [], errorCode: toToolError(error).code };
      }
    },
    async close() {
      if (store !== null) await store.close();
    },
  };
}

export type ToolInvocation =
  | {
      readonly ok: true;
      readonly tool: ToolName;
      readonly structured: Record<string, unknown>;
      readonly text: string;
    }
  | {
      readonly ok: false;
      readonly tool: ToolName | null;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details: Readonly<Record<string, SafeDetail>>;
      };
      readonly text: string;
    };

export interface InvokeOptions {
  /**
   * The call's abort signal, handed through the tools to the store so an
   * aborted call sends no further statement. The runtime that owns the MCP
   * request's cancellation and the deadline supplies it; this module does not
   * derive one of its own.
   */
  readonly signal?: AbortSignal | undefined;
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, rejectWith) => {
    timer = setTimeout(() => rejectWith(new ToolError('tool_timeout')), ms);
  });
  return Promise.race([work, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function requireStore(runtime: ToolRuntime): IncidentReadStoreProvider {
  if (runtime.store === null) throw new ToolError('database_not_configured');
  return runtime.store;
}

async function dispatch(
  runtime: ToolRuntime,
  name: ToolName,
  raw: unknown,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const context: ToolContext = { redact: runtime.redact, signal };
  switch (name) {
    case 'list_incidents': {
      const args = validateArguments(TOOL_DEFINITIONS[0].inputSchema, raw);
      return withDeadline(
        listIncidents(requireStore(runtime), args, context),
        runtime.deadlines.stored,
      );
    }
    case 'explain_incident': {
      const args = validateArguments(TOOL_DEFINITIONS[1].inputSchema, raw);
      return withDeadline(
        explainIncident(requireStore(runtime), args, context),
        runtime.deadlines.stored,
      );
    }
    case 'chain_anomalies': {
      const args = validateArguments(TOOL_DEFINITIONS[2].inputSchema, raw);
      const deadline = args.mode === 'live' ? runtime.deadlines.live : runtime.deadlines.stored;
      return withDeadline(
        chainAnomalies(
          {
            store: runtime.store,
            live: runtime.live,
            labeller: runtime.labeller,
            now: runtime.now,
          },
          args,
          context,
        ),
        deadline,
      );
    }
    case 'draft_section': {
      const args = validateArguments(TOOL_DEFINITIONS[3].inputSchema, raw);
      return withDeadline(
        draftSection(requireStore(runtime), runtime.previewer, args, context),
        runtime.deadlines.stored,
      );
    }
  }
}

/** Every validated argument is an identifier, an enumeration, an integer or an instant, so it is safe to log. */
function describeArguments(raw: unknown): string {
  if (raw === null || typeof raw !== 'object') return '{}';
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(raw).sort()) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      out[key] = value;
  }
  return JSON.stringify(out).slice(0, 400);
}

/**
 * Runs one tool. This is the single path every call takes, whether it
 * arrives over MCP or through the programmatic interface the tests use.
 */
export async function invokeTool(
  runtime: ToolRuntime,
  name: unknown,
  raw: unknown,
  options: InvokeOptions = {},
): Promise<ToolInvocation> {
  const started = Date.now();
  const tool = isToolName(name) ? name : null;
  let release: (() => void) | null = null;
  try {
    if (tool === null) throw new ToolError('unknown_tool');
    release = runtime.limiter.admit();
    const definition = TOOL_DEFINITIONS.find((entry) => entry.name === tool);
    if (definition === undefined) throw new ToolError('unknown_tool');
    const produced = await dispatch(runtime, tool, raw, options.signal);
    // The output contract is enforced here as well as by the SDK, so the
    // programmatic path cannot emit a shape the wire would refuse.
    const checked = definition.outputSchema.safeParse(produced);
    if (!checked.success) throw new ToolError('internal_error');
    const structured = redactDeep(checked.data as Record<string, unknown>, runtime.redact);
    const text = JSON.stringify(structured);
    if (Buffer.byteLength(text, 'utf8') > RESULT_MAX_BYTES) throw new ToolError('result_too_large');
    runtime.log(
      `cas-mcp-server tool=${tool} outcome=ok ms=${Date.now() - started} bytes=${Buffer.byteLength(text, 'utf8')} args=${describeArguments(raw)}`,
    );
    return { ok: true, tool, structured, text };
  } catch (error) {
    const failure = toToolError(error);
    const payload = {
      error: { code: failure.code, message: failure.message, details: failure.details },
    };
    const text = runtime.redact(JSON.stringify(payload));
    runtime.log(
      `cas-mcp-server tool=${tool ?? 'unknown'} outcome=${failure.code} ms=${Date.now() - started} args=${describeArguments(raw)}`,
    );
    return { ok: false, tool, error: payload.error, text };
  } finally {
    if (release !== null) release();
  }
}
