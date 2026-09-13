import { describe, expect, it } from 'vitest';

import { invokeTool } from './runtime.js';
import { FakeStore, hasRawControl, testRuntime, uuidFrom } from './test-support.js';

/**
 * Rejected argument objects are never inspected (Track D finding F11): no
 * accessor runs, no proxy trap fires, no raw value is logged, and every tool
 * answers with the one fixed rejection.
 */

const RUN = uuidFrom(4, 1);
const INCIDENT = uuidFrom(10, 2);

const REQUIRED: Record<string, string> = {
  list_incidents: 'evidenceRunId',
  explain_incident: 'incidentId',
  chain_anomalies: 'mode',
  draft_section: 'section',
};

const VALID: Record<string, Record<string, unknown>> = {
  list_incidents: { evidenceRunId: RUN },
  explain_incident: { evidenceRunId: RUN, incidentId: INCIDENT },
  chain_anomalies: { mode: 'stored', signalRunId: uuidFrom(3, 1), asOf: '2026-09-04T09:11:23Z' },
  draft_section: {
    evidenceRunId: RUN,
    section: 'header',
    periodStart: '2026-08-30T00:00:00Z',
    periodEnd: '2026-09-06T00:00:00Z',
  },
};

const MARKER = 'HOSTILE-VALUE-MARKER';

describe('hostile argument objects through invokeTool', () => {
  for (const tool of Object.keys(REQUIRED)) {
    it(`${tool}: a throwing getter on a required key never runs`, async () => {
      let invoked = 0;
      const hostile: Record<string, unknown> = { ...VALID[tool] };
      Object.defineProperty(hostile, REQUIRED[tool] as string, {
        enumerable: true,
        get: () => {
          invoked += 1;
          throw new Error(MARKER);
        },
      });
      const { runtime, logs } = testRuntime({ store: new FakeStore() });
      const outcome = await invokeTool(runtime, tool, hostile);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code).toBe('invalid_arguments');
        expect(outcome.error.details['reason']).toBe('accessor_property');
      }
      expect(invoked).toBe(0);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/outcome=invalid_arguments .*reason=accessor_property/);
      expect(logs[0]).not.toContain(MARKER);
      expect(runtime.limiter.inFlight).toBe(0);
    });

    it(`${tool}: a proxy fires no trap`, async () => {
      const traps: string[] = [];
      const handler: ProxyHandler<Record<string, unknown>> = {};
      for (const trap of [
        'get',
        'has',
        'ownKeys',
        'getOwnPropertyDescriptor',
        'getPrototypeOf',
        'defineProperty',
        'deleteProperty',
        'set',
      ] as const) {
        (handler as Record<string, unknown>)[trap] = (...args: unknown[]) => {
          traps.push(trap);
          throw new Error(`${MARKER} ${trap} ${String(args.length)}`);
        };
      }
      const hostile = new Proxy({ ...VALID[tool] }, handler);
      const { runtime, logs } = testRuntime({ store: new FakeStore() });
      const outcome = await invokeTool(runtime, tool, hostile);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.details['reason']).toBe('proxy');
      expect(traps).toEqual([]);
      expect(logs[0]).not.toContain(MARKER);
    });

    it(`${tool}: a non-enumerable accessor and a hostile descriptor never run`, async () => {
      let invoked = 0;
      const hidden: Record<string, unknown> = { ...VALID[tool] };
      Object.defineProperty(hidden, 'shadow', {
        enumerable: false,
        get: () => {
          invoked += 1;
          throw new Error(MARKER);
        },
      });
      const { runtime } = testRuntime({ store: new FakeStore() });
      const outcome = await invokeTool(runtime, tool, hidden);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.details['reason']).toBe('unexpected_key');
      expect(invoked).toBe(0);

      const bare = Object.create(null) as Record<string, unknown>;
      Object.assign(bare, VALID[tool]);
      Object.defineProperty(bare, REQUIRED[tool] as string, {
        enumerable: true,
        configurable: false,
        get: () => {
          invoked += 1;
          throw new Error(MARKER);
        },
        set: () => {
          invoked += 1;
        },
      });
      const again = await invokeTool(runtime, tool, bare);
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.error.details['reason']).toBe('accessor_property');
      expect(invoked).toBe(0);
    });

    it(`${tool}: a toString or valueOf trap on a value never runs`, async () => {
      let invoked = 0;
      const value = {
        toString: () => {
          invoked += 1;
          return RUN;
        },
        valueOf: () => {
          invoked += 1;
          return RUN;
        },
        [Symbol.toPrimitive]: () => {
          invoked += 1;
          return RUN;
        },
      };
      const hostile = { ...VALID[tool], [REQUIRED[tool] as string]: value };
      const { runtime, logs } = testRuntime({ store: new FakeStore() });
      const outcome = await invokeTool(runtime, tool, hostile);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.details['reason']).toBe('non_primitive_value');
      expect(invoked).toBe(0);
      expect(logs[0]).not.toContain(MARKER);
      expect(hasRawControl(logs[0] ?? '')).toBe(false);
    });
  }

  it('logs the validated copy on success and only a fixed summary on rejection', async () => {
    const { runtime, logs } = testRuntime({ store: new FakeStore() });
    await invokeTool(runtime, 'list_incidents', { evidenceRunId: RUN });
    expect(logs[0]).toContain(`args={"evidenceRunId":"${RUN}","limit":20}`);
    await invokeTool(runtime, 'list_incidents', { evidenceRunId: `${MARKER}-not-a-uuid` });
    expect(logs[1]).toMatch(
      /outcome=invalid_arguments .*reason=schema_violation argument=evidenceRunId .*args=-$/,
    );
    expect(logs[1]).not.toContain(MARKER);
  });
});
