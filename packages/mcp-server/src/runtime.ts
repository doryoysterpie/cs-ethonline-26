import { DATABASE_URL_VARIABLE, parseDatabaseConfig } from '@cas/database';

import {
  LIVE_TOOL_DEADLINE_MS,
  MAX_CONCURRENT_CALLS,
  RATE_LIMIT_CALLS,
  RATE_LIMIT_WINDOW_MS,
  RESULT_MAX_BYTES,
  SHUTDOWN_DEADLINE_MS,
  STORED_TOOL_DEADLINE_MS,
  UNWIND_GRACE_MS,
} from './bounds.js';
import { TOOL_DEFINITIONS, isToolName, type ToolName } from './definitions.js';
import { evidenceContractLabeller, type AnomalyLabeller } from './engines/anomaly.js';
import { deterministicPreviewer, type DraftPreviewer } from './engines/draft.js';
import { GraphLiveSignalSource, type LiveSignalSource } from './engines/live-graph.js';
import { CallScope, errorForCause, sleep, throwIfAborted } from './safety/cancellation.js';
import { ToolError, toToolError, type SafeDetail } from './safety/errors.js';
import { connectionSecrets, createRedactor, redactDeep, type Redactor } from './safety/redact.js';
import { toSingleLine } from './safety/text.js';
import type {
  ChainAnomaliesArguments,
  DraftSectionArguments,
  ExplainIncidentArguments,
  ListIncidentsArguments,
} from './schemas/input.js';
import { PostgresReadStore } from './store/postgres-store.js';
import type { IncidentReadStore } from './store/read-store.js';
import { chainAnomalies } from './tools/chain-anomalies.js';
import { draftSection } from './tools/draft-section.js';
import { explainIncident } from './tools/explain-incident.js';
import { listIncidents } from './tools/list-incidents.js';
import type { ToolContext } from './tools/shared.js';
import { validateArguments } from './validation.js';

/**
 * The tool runtime: what a tool may reach, and the one function that runs a
 * tool. Every call passes, in order, the name check, the rate limit, the
 * concurrency cap, the hardened argument boundary, one call-scoped
 * cancellation state, the output contract, the redactor and the size bound. A
 * failure at any step is a fixed-vocabulary error; nothing else leaves.
 *
 * Cancellation (Track D finding F1): each call owns one `CallScope` whose
 * signal is aborted by the first of the wall-clock deadline, the client's
 * protocol cancellation or the runtime's shutdown. That signal reaches every
 * store read, every PostgreSQL statement and every live fetch. When it fires,
 * the runtime waits for the work to unwind, bounded by a grace period, before
 * it reports; the concurrency permit is released only once the work has
 * actually unwound, however late that is; and shutdown aborts every active
 * call and waits, bounded, for the same.
 *
 * Logging (Track D finding F11) never reads a raw argument. A successful call
 * logs the validated plain copy, whose values are identifiers, enumerations,
 * integers and instants; a rejected call logs the fixed rejection reason and
 * at most an allowlisted argument name.
 */

/** The only environment names this server reads. Values are never emitted. */
export const ENVIRONMENT_NAMES = [
  DATABASE_URL_VARIABLE,
  'GRAPH_API_KEY',
  'GRAPH_GATEWAY_URL',
] as const;

/** A call whose underlying work has not yet unwound. */
export interface ActiveCall {
  readonly tool: ToolName;
  readonly scope: CallScope;
  /** Settles once the underlying work has settled, whatever its outcome. */
  readonly unwound: Promise<void>;
}

export interface ToolRuntime {
  /** Null when `DATABASE_URL` is absent; stored tools then fail with a fixed code. */
  readonly store: IncidentReadStore | null;
  /** Null when `GRAPH_API_KEY` is absent; live mode then fails with a fixed code and no fallback. */
  readonly live: LiveSignalSource | null;
  readonly labeller: AnomalyLabeller;
  readonly previewer: DraftPreviewer;
  readonly redact: Redactor;
  readonly now: () => Date;
  /** Receives one redacted, single-line record per call. Never stdout. */
  readonly log: (line: string) => void;
  readonly deadlines: { readonly stored: number; readonly live: number };
  readonly limiter: CallLimiter;
  /** How long an aborted call may take to unwind before its outcome is reported anyway. */
  readonly unwindGraceMs: number;
  /** How long shutdown waits for aborted calls to unwind. */
  readonly shutdownDeadlineMs: number;
  /** Aborts every active call when the runtime closes. */
  readonly shutdownSignal: AbortSignal;
  /** Calls whose underlying work has not unwound. */
  readonly active: ReadonlySet<ActiveCall>;
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

  /** Permits currently held. A permit is held until the call's work has unwound. */
  get inFlight(): number {
    return this.#inFlight;
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
  /** The base fetch the gateway policy wraps. Defaults to the global fetch. */
  readonly fetchImpl?: ConstructorParameters<typeof GraphLiveSignalSource>[0]['fetchImpl'];
  readonly store?: IncidentReadStore | null | undefined;
  readonly live?: LiveSignalSource | null | undefined;
  readonly labeller?: AnomalyLabeller | undefined;
  readonly previewer?: DraftPreviewer | undefined;
  readonly deadlines?: { readonly stored: number; readonly live: number } | undefined;
  readonly limiter?: CallLimiter | undefined;
  readonly unwindGraceMs?: number | undefined;
  readonly shutdownDeadlineMs?: number | undefined;
}

function present(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

/**
 * Builds a runtime from the allowlisted environment names. A configured
 * `DATABASE_URL` is validated in full before anything else, so a rejected
 * value stops the server rather than reaching a redactor-less path; an absent
 * one leaves the store null. `GRAPH_API_KEY` constructs the live client, whose
 * own validation rejects a bad gateway URL before any request.
 */
export function createRuntime(options: RuntimeOptions): ToolRuntime {
  const databaseUrl = present(options.env[DATABASE_URL_VARIABLE]);
  const apiKey = present(options.env['GRAPH_API_KEY']);
  const gatewayBaseUrl = present(options.env['GRAPH_GATEWAY_URL']);
  const redact = createRedactor([...connectionSecrets(databaseUrl), apiKey]);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const safeLog = (line: string): void => log(toSingleLine(redact(line)));

  let store: IncidentReadStore | null;
  if (options.store !== undefined) {
    store = options.store;
  } else if (databaseUrl === undefined) {
    store = null;
  } else {
    store = PostgresReadStore.open(parseDatabaseConfig(options.env));
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
      log: safeLog,
    });
  }

  const shutdown = new AbortController();
  const active = new Set<ActiveCall>();
  const shutdownDeadlineMs = options.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS;
  let closing: Promise<void> | null = null;

  const close = async (): Promise<void> => {
    if (!shutdown.signal.aborted) shutdown.abort('shutdown');
    const pending = [...active];
    if (pending.length > 0) {
      const drained = Promise.allSettled(pending.map((call) => call.unwound)).then(() => true);
      const expired = sleep(shutdownDeadlineMs).then(() => false);
      const unwound = await Promise.race([drained, expired]);
      safeLog(
        `cas-mcp-server shutdown active_calls=${pending.length} unwound=${unwound} within_ms=${shutdownDeadlineMs}`,
      );
    }
    if (store !== null) {
      // A pool whose client is stuck would keep the process alive; the wait is bounded.
      await Promise.race([store.close(), sleep(shutdownDeadlineMs)]);
    }
  };

  return {
    store,
    live,
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
    unwindGraceMs: options.unwindGraceMs ?? UNWIND_GRACE_MS,
    shutdownDeadlineMs,
    shutdownSignal: shutdown.signal,
    active,
    close(): Promise<void> {
      closing ??= close();
      return closing;
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
  /** The protocol's own cancellation signal for this request, when the transport supplies one. */
  readonly signal?: AbortSignal | undefined;
}

function requireStore(runtime: ToolRuntime): IncidentReadStore {
  if (runtime.store === null) throw new ToolError('database_not_configured');
  return runtime.store;
}

/** Validates for the named tool. The result is a plain copy: nothing here can hold an accessor. */
function validateFor(tool: ToolName, raw: unknown): Record<string, unknown> {
  switch (tool) {
    case 'list_incidents':
      return validateArguments(TOOL_DEFINITIONS[0].inputSchema, raw);
    case 'explain_incident':
      return validateArguments(TOOL_DEFINITIONS[1].inputSchema, raw);
    case 'chain_anomalies':
      return validateArguments(TOOL_DEFINITIONS[2].inputSchema, raw);
    case 'draft_section':
      return validateArguments(TOOL_DEFINITIONS[3].inputSchema, raw);
  }
}

function dispatch(
  runtime: ToolRuntime,
  tool: ToolName,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<Record<string, unknown>> {
  switch (tool) {
    case 'list_incidents':
      return listIncidents(requireStore(runtime), args as ListIncidentsArguments, context);
    case 'explain_incident':
      return explainIncident(requireStore(runtime), args as ExplainIncidentArguments, context);
    case 'chain_anomalies':
      return chainAnomalies(
        {
          store: runtime.store,
          live: runtime.live,
          labeller: runtime.labeller,
          now: runtime.now,
          signal: context.signal,
          redact: context.redact,
        },
        args as ChainAnomaliesArguments,
      );
    case 'draft_section':
      return draftSection(
        requireStore(runtime),
        runtime.previewer,
        args as DraftSectionArguments,
        context,
      );
  }
}

/**
 * Races the work against the scope's signal. If the signal fires first, the
 * work is given the grace period to unwind before the fixed outcome is
 * reported; whether or not it unwinds in time, the caller learns which from
 * the returned flag through `settled`.
 */
async function awaitWithinScope<T>(
  work: Promise<T>,
  scope: CallScope,
  graceMs: number,
): Promise<T> {
  const listener = { detach: (): void => undefined };
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(errorForCause(scope.cause ?? 'client_cancelled'));
    if (scope.aborted) {
      onAbort();
      return;
    }
    scope.signal.addEventListener('abort', onAbort, { once: true });
    listener.detach = () => scope.signal.removeEventListener('abort', onAbort);
  });
  // The race settles the abort promise's rejection either way.
  aborted.catch(() => undefined);
  try {
    return await Promise.race([work, aborted]);
  } catch (error) {
    if (!scope.aborted) throw error;
    // The work was told to stop. Give it the grace period to unwind before
    // the fixed outcome is reported; the permit stays held regardless.
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined,
      ),
      sleep(graceMs),
    ]);
    throw errorForCause(scope.cause ?? 'client_cancelled');
  } finally {
    listener.detach();
  }
}

/** The validated copy holds identifiers, enumerations, integers and instants only. */
function describeValidated(args: Record<string, unknown> | null): string {
  if (args === null) return '-';
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) {
    const value = args[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return JSON.stringify(out).slice(0, 400);
}

function safeDetail(details: Readonly<Record<string, SafeDetail>>, key: string): string {
  const value = details[key];
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : '-';
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
  let scope: CallScope | null = null;
  let validated: Record<string, unknown> | null = null;
  let work: Promise<Record<string, unknown>> | null = null;
  let workSettled = false;
  try {
    if (tool === null) throw new ToolError('unknown_tool');
    release = runtime.limiter.admit();
    const definition = TOOL_DEFINITIONS.find((entry) => entry.name === tool);
    if (definition === undefined) throw new ToolError('unknown_tool');
    // Validation runs before any work starts, so a rejected object needs no
    // cancellation and is never read again.
    validated = validateFor(tool, raw);
    const deadline =
      tool === 'chain_anomalies' && validated['mode'] === 'live'
        ? runtime.deadlines.live
        : runtime.deadlines.stored;
    const callScope = new CallScope({
      client: options.signal,
      shutdown: runtime.shutdownSignal,
      deadlineMs: deadline,
    });
    scope = callScope;
    // A call that arrives already cancelled or after shutdown does no work.
    throwIfAborted(callScope.signal);
    const started_work = dispatch(runtime, tool, validated, {
      signal: callScope.signal,
      redact: runtime.redact,
    });
    work = started_work;
    const unwound = started_work.then(
      () => undefined,
      () => undefined,
    );
    void unwound.then(() => {
      workSettled = true;
    });
    const entry: ActiveCall = { tool, scope: callScope, unwound };
    (runtime.active as Set<ActiveCall>).add(entry);
    void unwound.then(() => (runtime.active as Set<ActiveCall>).delete(entry));

    const produced = await awaitWithinScope(started_work, callScope, runtime.unwindGraceMs);
    // The output contract is enforced here as well as by the SDK, so the
    // programmatic path cannot emit a shape the wire would refuse.
    const checked = definition.outputSchema.safeParse(produced);
    if (!checked.success) throw new ToolError('internal_error');
    const structured = redactDeep(checked.data as Record<string, unknown>, runtime.redact);
    const text = JSON.stringify(structured);
    if (Buffer.byteLength(text, 'utf8') > RESULT_MAX_BYTES) throw new ToolError('result_too_large');
    runtime.log(
      `cas-mcp-server tool=${tool} outcome=ok ms=${Date.now() - started} bytes=${Buffer.byteLength(text, 'utf8')} args=${describeValidated(validated)}`,
    );
    return { ok: true, tool, structured, text };
  } catch (error) {
    const cause = scope?.cause ?? null;
    const failure = cause !== null ? errorForCause(cause) : toToolError(error);
    const payload = {
      error: { code: failure.code, message: failure.message, details: failure.details },
    };
    const text = runtime.redact(JSON.stringify(payload));
    runtime.log(
      `cas-mcp-server tool=${tool ?? 'unknown'} outcome=${failure.code} ms=${Date.now() - started} reason=${safeDetail(failure.details, 'reason')} argument=${safeDetail(failure.details, 'argument')} unwound=${work === null || workSettled} args=${describeValidated(validated)}`,
    );
    return { ok: false, tool, error: payload.error, text };
  } finally {
    scope?.dispose();
    if (release !== null) {
      const free = release;
      if (work === null || workSettled) free();
      else void work.then(free, free);
    }
  }
}
