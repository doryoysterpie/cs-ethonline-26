import { ToolError } from './errors.js';

/**
 * One cancellation state per tool call (Track D finding F1).
 *
 * A call is aborted for exactly one of three causes: its wall-clock deadline
 * fired, the client cancelled the request through the protocol, or the
 * server is shutting down. Whichever comes first sets the cause on a single
 * `AbortController` whose signal travels through the runtime, the read store,
 * every PostgreSQL statement and every live fetch. Downstream code never races
 * against a timer of its own: it observes this one signal and unwinds.
 */

export const ABORT_CAUSES = ['deadline', 'client_cancelled', 'shutdown'] as const;
export type AbortCause = (typeof ABORT_CAUSES)[number];

export function abortCause(signal: AbortSignal | undefined): AbortCause | null {
  if (signal === undefined || !signal.aborted) return null;
  const reason: unknown = signal.reason;
  return typeof reason === 'string' && (ABORT_CAUSES as readonly string[]).includes(reason)
    ? (reason as AbortCause)
    : 'client_cancelled';
}

/** The tool error a cause maps to. A deadline is a timeout; everything else is a cancellation. */
export function errorForCause(cause: AbortCause): ToolError {
  return cause === 'deadline' ? new ToolError('tool_timeout') : new ToolError('call_cancelled');
}

/** Throws the fixed error for the signal's cause when it is aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  const cause = abortCause(signal);
  if (cause !== null) throw errorForCause(cause);
}

export interface CallScopeOptions {
  /** The protocol's own signal for this request, when the transport supplies one. */
  readonly client?: AbortSignal | undefined;
  /** The runtime's shutdown signal. */
  readonly shutdown?: AbortSignal | undefined;
  /** Wall-clock budget for the call, in milliseconds. */
  readonly deadlineMs: number;
}

export class CallScope {
  readonly #controller = new AbortController();
  readonly #timer: NodeJS.Timeout;
  readonly #detach: (() => void)[] = [];

  constructor(options: CallScopeOptions) {
    this.#timer = setTimeout(() => this.abort('deadline'), options.deadlineMs);
    this.#link(options.client, 'client_cancelled');
    this.#link(options.shutdown, 'shutdown');
  }

  #link(source: AbortSignal | undefined, cause: AbortCause): void {
    if (source === undefined) return;
    if (source.aborted) {
      this.abort(cause);
      return;
    }
    const onAbort = (): void => this.abort(cause);
    source.addEventListener('abort', onAbort, { once: true });
    this.#detach.push(() => source.removeEventListener('abort', onAbort));
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get aborted(): boolean {
    return this.#controller.signal.aborted;
  }

  get cause(): AbortCause | null {
    return abortCause(this.#controller.signal);
  }

  abort(cause: AbortCause): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(cause);
  }

  /** Clears the timer and the links. The signal keeps whatever state it reached. */
  dispose(): void {
    clearTimeout(this.#timer);
    for (const detach of this.#detach) detach();
    this.#detach.length = 0;
  }
}

/** A signal that aborts when either input aborts, or undefined when neither exists. */
export function combineSignals(
  ...signals: readonly (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

/** Resolves after `ms`, or immediately when the signal is already aborted. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
