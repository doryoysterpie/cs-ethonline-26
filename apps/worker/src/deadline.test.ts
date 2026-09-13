import { RESOURCE_LIMITS } from '@cas/contracts';
import { describe, expect, it } from 'vitest';

import {
  armCommandDeadline,
  COMMAND_DEADLINE_VARIABLE,
  resolveCommandDeadline,
  type DeadlineTimers,
} from './deadline.js';
import { isIngestionError } from './editorial/errors.js';

/** Timers the test advances by hand, so nothing here depends on wall-clock time. */
function fakeTimers(): DeadlineTimers & {
  pending: { callback: () => void; ms: number }[];
  fire(): void;
} {
  const pending: { callback: () => void; ms: number }[] = [];
  return {
    pending,
    set(callback, ms) {
      const entry = { callback, ms };
      pending.push(entry);
      return entry;
    },
    clear(handle) {
      const index = pending.indexOf(handle as { callback: () => void; ms: number });
      if (index >= 0) pending.splice(index, 1);
    },
    fire() {
      const next = pending.shift();
      if (next !== undefined) next.callback();
    },
  };
}

describe('resolveCommandDeadline', () => {
  it('defaults to the versioned ceiling and grace period', () => {
    expect(resolveCommandDeadline({})).toEqual({
      deadlineMs: RESOURCE_LIMITS.command.durationMs,
      graceMs: RESOURCE_LIMITS.command.graceMs,
    });
    expect(resolveCommandDeadline({ [COMMAND_DEADLINE_VARIABLE]: '' })).toEqual(
      resolveCommandDeadline({}),
    );
    expect(resolveCommandDeadline({ [COMMAND_DEADLINE_VARIABLE]: '   ' })).toEqual(
      resolveCommandDeadline({}),
    );
  });

  it('accepts a lower deadline, up to and including the ceiling', () => {
    expect(resolveCommandDeadline({ [COMMAND_DEADLINE_VARIABLE]: '1' }).deadlineMs).toBe(1);
    const ceiling = String(RESOURCE_LIMITS.command.durationMs);
    expect(resolveCommandDeadline({ [COMMAND_DEADLINE_VARIABLE]: ceiling }).deadlineMs).toBe(
      RESOURCE_LIMITS.command.durationMs,
    );
    const below = String(RESOURCE_LIMITS.command.durationMs - 1);
    expect(resolveCommandDeadline({ [COMMAND_DEADLINE_VARIABLE]: below }).deadlineMs).toBe(
      RESOURCE_LIMITS.command.durationMs - 1,
    );
  });

  it('refuses a deadline above the ceiling with a fixed configuration error', () => {
    const above = String(RESOURCE_LIMITS.command.durationMs + 1);
    let caught: unknown;
    try {
      resolveCommandDeadline({ [COMMAND_DEADLINE_VARIABLE]: above });
    } catch (error) {
      caught = error;
    }
    if (!isIngestionError(caught)) throw new Error('expected an IngestionError');
    expect(caught.kind).toBe('configuration');
    expect(caught.code).toBe('command_deadline_invalid');
    expect(caught.message).toBe(
      'CAS_COMMAND_DEADLINE_MS exceeds the versioned command duration ceiling',
    );
    expect(caught.details).toEqual({
      ceiling: RESOURCE_LIMITS.command.durationMs,
      requested: RESOURCE_LIMITS.command.durationMs + 1,
    });
  });

  it('refuses every malformed value with the same fixed message and echoes nothing', () => {
    for (const bad of ['0', '-5', '1.5', '10ms', ' 10', '1e3', '99999999999', 'Infinity', 'NaN']) {
      let caught: unknown;
      try {
        resolveCommandDeadline({ [COMMAND_DEADLINE_VARIABLE]: bad });
      } catch (error) {
        caught = error;
      }
      if (!isIngestionError(caught)) throw new Error(`expected a rejection for ${bad}`);
      expect(caught.code).toBe('command_deadline_invalid');
      expect(caught.message).toBe(
        'CAS_COMMAND_DEADLINE_MS must be a positive integer number of milliseconds',
      );
      expect(JSON.stringify(caught.details)).not.toContain(bad.trim());
    }
  });
});

describe('armCommandDeadline', () => {
  it('fires the abort at the deadline and the exit only after the grace period', () => {
    const timers = fakeTimers();
    const events: string[] = [];
    const armed = armCommandDeadline(
      { deadlineMs: 1000, graceMs: 50 },
      {
        onExpire: () => events.push('expire'),
        onGraceExpired: () => events.push('exit'),
        timers,
      },
    );
    expect(armed.fired()).toBe(false);
    expect(timers.pending.map((entry) => entry.ms)).toEqual([1000]);
    timers.fire();
    expect(armed.fired()).toBe(true);
    expect(events).toEqual(['expire']);
    expect(timers.pending.map((entry) => entry.ms)).toEqual([50]);
    timers.fire();
    expect(events).toEqual(['expire', 'exit']);
    expect(timers.pending).toEqual([]);
  });

  it('disarms before the deadline, so a finished command triggers nothing', () => {
    const timers = fakeTimers();
    const events: string[] = [];
    const armed = armCommandDeadline(
      { deadlineMs: 10, graceMs: 10 },
      { onExpire: () => events.push('expire'), onGraceExpired: () => events.push('exit'), timers },
    );
    armed.disarm();
    armed.disarm();
    expect(timers.pending).toEqual([]);
    timers.fire();
    expect(events).toEqual([]);
    expect(armed.fired()).toBe(false);
  });

  it('disarms the grace timer when the command returns during the grace period', () => {
    const timers = fakeTimers();
    const events: string[] = [];
    const armed = armCommandDeadline(
      { deadlineMs: 10, graceMs: 10 },
      { onExpire: () => events.push('expire'), onGraceExpired: () => events.push('exit'), timers },
    );
    timers.fire();
    expect(events).toEqual(['expire']);
    armed.disarm();
    expect(timers.pending).toEqual([]);
    timers.fire();
    expect(events).toEqual(['expire']);
    expect(armed.fired()).toBe(true);
  });
});
