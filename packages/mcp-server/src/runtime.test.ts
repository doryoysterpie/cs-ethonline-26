import { describe, expect, it } from 'vitest';

import { DRAFT_MARKDOWN_MAX_CHARACTERS } from './bounds.js';
import type { DraftPreviewer } from './engines/draft.js';
import {
  CallLimiter,
  createRuntime,
  ENVIRONMENT_NAMES,
  invokeTool,
  MODE_VARIABLE,
  parseStoreMode,
} from './runtime.js';
import {
  AS_OF,
  FakeStore,
  SECRET_API_KEY,
  SECRET_DATABASE_URL,
  testRuntime,
  uuidFrom,
} from './test-support.js';

/**
 * The invocation path: deadlines, rate limits, concurrency, result bounds,
 * environment discipline and the programmatic entry the tests share with
 * the wire.
 */

const RUN = uuidFrom(4, 1);
const SIGNAL_RUN = uuidFrom(3, 1);

describe('deadlines and bounds', () => {
  it('turns a hung store into a timeout within the budget', async () => {
    const store = new FakeStore();
    store.hang = true;
    const { runtime } = testRuntime({ store, deadlines: { stored: 200, live: 200 } });
    const started = Date.now();
    const outcome = await invokeTool(runtime, 'list_incidents', { evidenceRunId: RUN });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('tool_timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses a preview past the size bound with a fixed code', async () => {
    const previewer: DraftPreviewer = {
      preview: () => ({
        markdown: 'x'.repeat(DRAFT_MARKDOWN_MAX_CHARACTERS + 1),
        draftingVersion: 'deterministic-drafter@1',
        contractVersion: 'drafting-behavior-contract@1',
        contractHash: 'ab'.repeat(32),
        counts: {
          incidents: 0,
          claimsWritten: 0,
          claimsOmitted: 0,
          namesWithheld: 0,
          contradicted: 0,
          cryptoIncidents: 0,
        },
      }),
    };
    const { runtime } = testRuntime({ store: new FakeStore(), previewer });
    const outcome = await invokeTool(runtime, 'draft_section', {
      evidenceRunId: RUN,
      section: 'incidents',
      periodStart: '2026-08-30T00:00:00Z',
      periodEnd: '2026-09-06T00:00:00Z',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('result_too_large');
  });

  it('sends nothing to the store once the call is aborted, and answers with a fixed code', async () => {
    const store = new FakeStore();
    const { runtime } = testRuntime({ store });
    const outcome = await invokeTool(
      runtime,
      'list_incidents',
      { evidenceRunId: RUN },
      { signal: AbortSignal.abort() },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('tool_timeout');
    expect(store.calls).toEqual([]);
    expect(store.transactions).toBe(0);
  });

  it('opens exactly one transaction per tool call', async () => {
    const store = new FakeStore();
    const { runtime } = testRuntime({ store });
    await invokeTool(runtime, 'list_incidents', { evidenceRunId: RUN });
    await invokeTool(runtime, 'explain_incident', {
      evidenceRunId: RUN,
      incidentId: uuidFrom(10, 2),
    });
    await invokeTool(runtime, 'chain_anomalies', {
      mode: 'stored',
      signalRunId: SIGNAL_RUN,
      asOf: AS_OF,
    });
    await invokeTool(runtime, 'draft_section', {
      evidenceRunId: RUN,
      section: 'header',
      periodStart: '2026-08-30T00:00:00Z',
      periodEnd: '2026-09-06T00:00:00Z',
    });
    expect(store.transactions).toBe(4);
    // Reads of one call all happened inside its transaction: the explanation
    // made four reads and opened one transaction.
    expect(store.calls.filter((c) => c === 'getIncidentSummary')).toHaveLength(1);
  });

  it('refuses an output that violates its own contract rather than emitting it', async () => {
    const previewer: DraftPreviewer = {
      preview: () => ({
        markdown: 'fine',
        draftingVersion: 'deterministic-drafter@1',
        contractVersion: 'drafting-behavior-contract@1',
        contractHash: 'not-a-hash',
        counts: {
          incidents: 0,
          claimsWritten: 0,
          claimsOmitted: 0,
          namesWithheld: 0,
          contradicted: 0,
          cryptoIncidents: 0,
        },
      }),
    };
    const { runtime } = testRuntime({ store: new FakeStore(), previewer });
    const outcome = await invokeTool(runtime, 'draft_section', {
      evidenceRunId: RUN,
      section: 'header',
      periodStart: '2026-08-30T00:00:00Z',
      periodEnd: '2026-09-06T00:00:00Z',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('internal_error');
  });
});

describe('rate limiting', () => {
  it('admits calls up to the window and refuses the next one', () => {
    let clock = 1_000_000;
    const limiter = new CallLimiter({ calls: 3, windowMs: 1000, concurrent: 10, now: () => clock });
    limiter.admit()();
    limiter.admit()();
    limiter.admit()();
    expect(() => limiter.admit()).toThrow(/too many tool calls in the current window/);
    clock += 1001;
    expect(() => limiter.admit()()).not.toThrow();
  });

  it('caps concurrency and releases a slot exactly once', () => {
    const limiter = new CallLimiter({ calls: 100, windowMs: 1000, concurrent: 1 });
    const release = limiter.admit();
    expect(() => limiter.admit()).toThrow(/in flight/);
    release();
    release();
    expect(() => limiter.admit()()).not.toThrow();
  });

  it('reports a burst beyond the limit as rate_limited through the invocation path', async () => {
    const limiter = new CallLimiter({ calls: 2, windowMs: 60_000, concurrent: 4 });
    const { runtime } = testRuntime({ store: new FakeStore(), limiter });
    const first = await invokeTool(runtime, 'list_incidents', { evidenceRunId: RUN });
    const second = await invokeTool(runtime, 'list_incidents', { evidenceRunId: RUN });
    const third = await invokeTool(runtime, 'list_incidents', { evidenceRunId: RUN });
    expect(first.ok && second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error.code).toBe('rate_limited');
  });
});

describe('the programmatic entry', () => {
  it('refuses an unknown or non-string tool name with a fixed code', async () => {
    const { runtime } = testRuntime({ store: new FakeStore() });
    for (const name of ['nope', 42, null, undefined, Symbol('x'), {}]) {
      const outcome = await invokeTool(runtime, name, {});
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.code).toBe('unknown_tool');
    }
  });

  it('logs one redacted single-line record per call, with arguments that are identifiers only', async () => {
    const { runtime, logs } = testRuntime({
      store: new FakeStore(),
      env: { DATABASE_URL: SECRET_DATABASE_URL, GRAPH_API_KEY: SECRET_API_KEY },
    });
    await invokeTool(runtime, 'chain_anomalies', {
      mode: 'stored',
      signalRunId: SIGNAL_RUN,
      asOf: AS_OF,
    });
    await invokeTool(runtime, 'list_incidents', { evidenceRunId: RUN, sql: SECRET_API_KEY });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(
      /^cas-mcp-server tool=chain_anomalies outcome=ok ms=\d+ bytes=\d+ args=/,
    );
    expect(logs[1]).toMatch(/outcome=invalid_arguments/);
    for (const line of logs) {
      expect(line).not.toContain(SECRET_API_KEY);
      expect(line.includes('\n')).toBe(false);
    }
  });
});

describe('environment discipline', () => {
  it('reads only the allowlisted names', () => {
    const touched = new Set<string>();
    const env = new Proxy<Record<string, string | undefined>>(
      { DATABASE_URL: '', GRAPH_API_KEY: '', SECRET_THING: 'x', HOME: '/h' },
      {
        get(target, property) {
          if (typeof property === 'string') touched.add(property);
          return target[property as string];
        },
        ownKeys() {
          throw new Error('the environment must not be enumerated');
        },
      },
    );
    const runtime = createRuntime({ env, log: () => undefined });
    expect(runtime.store).toBeNull();
    expect(runtime.live).toBeNull();
    expect([...touched].sort()).toEqual([...ENVIRONMENT_NAMES].sort());
    expect(ENVIRONMENT_NAMES).toContain(MODE_VARIABLE);
  });

  it('defaults to production mode, accepts development, and rejects anything else without echoing it', () => {
    expect(createRuntime({ env: {}, log: () => undefined }).mode).toBe('production');
    expect(createRuntime({ env: { CAS_MCP_MODE: '' }, log: () => undefined }).mode).toBe(
      'production',
    );
    expect(createRuntime({ env: { CAS_MCP_MODE: 'development' }, log: () => undefined }).mode).toBe(
      'development',
    );
    expect(parseStoreMode(undefined)).toBe('production');
    let message = '';
    try {
      createRuntime({ env: { CAS_MCP_MODE: 'staging-secret-name' }, log: () => undefined });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('CAS_MCP_MODE rejected');
    expect(message).not.toContain('staging');
  });

  it('reports the database role as absent without a store, and as verified through a provider', async () => {
    const bare = createRuntime({ env: {}, log: () => undefined });
    expect(await bare.verifyDatabaseRole()).toEqual({
      status: 'absent',
      failed: [],
      errorCode: null,
    });
    const { runtime } = testRuntime({ store: new FakeStore() });
    expect((await runtime.verifyDatabaseRole()).status).toBe('verified');
  });

  it('rejects a malformed DATABASE_URL at startup without echoing it', () => {
    let message = '';
    try {
      createRuntime({ env: { DATABASE_URL: 'mysql://user:pw@host/db' }, log: () => undefined });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('scheme must be postgres or postgresql');
    expect(message).not.toContain('mysql://');
  });
});
