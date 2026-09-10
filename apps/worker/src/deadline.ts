import { RESOURCE_LIMITS } from '@cas/contracts';

import { IngestionError } from './editorial/errors.js';

/**
 * The command deadline (`RESOURCE_LIMITS.command`, decision D27).
 *
 * Every worker command runs under a deadline. When it expires the command's
 * abort signal fires, which the import and validation paths honour by
 * stopping the read and rolling the batch back; after a short grace period
 * the process exits with a distinct code whether or not the command has
 * returned, and the database rolls back whatever transaction the dropped
 * connection was inside. No command can therefore hold a connection, a file
 * handle or memory indefinitely, and no partial batch survives the exit,
 * because every write path is one transaction.
 *
 * The deadline may be lowered through `CAS_COMMAND_DEADLINE_MS` and never
 * raised above the versioned ceiling. The variable is validated before any
 * command runs; a malformed or oversized value is a configuration error.
 */

export const COMMAND_DEADLINE_VARIABLE = 'CAS_COMMAND_DEADLINE_MS';

export interface CommandDeadline {
  readonly deadlineMs: number;
  readonly graceMs: number;
}

const MILLISECONDS = /^[1-9][0-9]{0,9}$/u;

export function resolveCommandDeadline(
  env: Readonly<Record<string, string | undefined>>,
): CommandDeadline {
  const ceiling = RESOURCE_LIMITS.command.durationMs;
  const graceMs = RESOURCE_LIMITS.command.graceMs;
  const raw = env[COMMAND_DEADLINE_VARIABLE];
  if (raw === undefined || raw.trim().length === 0) return { deadlineMs: ceiling, graceMs };
  if (!MILLISECONDS.test(raw)) {
    throw new IngestionError(
      'configuration',
      'command_deadline_invalid',
      `${COMMAND_DEADLINE_VARIABLE} must be a positive integer number of milliseconds`,
    );
  }
  const requested = Number(raw);
  if (requested > ceiling) {
    throw new IngestionError(
      'configuration',
      'command_deadline_invalid',
      `${COMMAND_DEADLINE_VARIABLE} exceeds the versioned command duration ceiling`,
      { ceiling, requested },
    );
  }
  return { deadlineMs: requested, graceMs };
}

export interface DeadlineTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface DeadlineHooks {
  /** Called once when the deadline expires. Abort the command here. */
  readonly onExpire: () => void;
  /** Called once when the grace period after expiry also passes. Exit here. */
  readonly onGraceExpired: () => void;
  readonly timers?: DeadlineTimers | undefined;
}

export interface ArmedDeadline {
  /** True once the deadline has expired. */
  fired(): boolean;
  /** Cancels whichever timer is pending. Safe to call more than once. */
  disarm(): void;
}

const REAL_TIMERS: DeadlineTimers = {
  set(callback, ms) {
    const handle = setTimeout(callback, ms);
    // A pending deadline must never keep a finished process alive.
    handle.unref();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** Starts the deadline. The grace timer is armed only after the deadline has fired. */
export function armCommandDeadline(deadline: CommandDeadline, hooks: DeadlineHooks): ArmedDeadline {
  const timers = hooks.timers ?? REAL_TIMERS;
  let fired = false;
  let handle: unknown = timers.set(() => {
    fired = true;
    handle = timers.set(() => {
      handle = null;
      hooks.onGraceExpired();
    }, deadline.graceMs);
    hooks.onExpire();
  }, deadline.deadlineMs);
  return {
    fired: () => fired,
    disarm() {
      if (handle !== null) {
        timers.clear(handle);
        handle = null;
      }
    },
  };
}
