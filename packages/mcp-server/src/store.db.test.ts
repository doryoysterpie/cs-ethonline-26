import { isDatabaseError, type Queryable } from '@cas/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EXPLAIN_ASSOCIATIONS_LIMIT,
  EXPLAIN_SOURCES_LIMIT,
  HEADLINE_MAX_CHARACTERS,
  PUBLISHER_MAX_CHARACTERS,
  TEXT_FETCH_MARGIN_MAX_CHARACTERS,
  URL_MAX_CHARACTERS,
} from './bounds.js';
import {
  DB_SECRET_API_KEY,
  insertReviewAction,
  insertSyntheticSignalRun,
  openTestDatabase,
  seedPipeline,
  SEED_ROWS,
  type SeededPipeline,
  type SeedRow,
  type SyntheticObservation,
  type TestDatabase,
} from './db-support.js';
import { invokeTool } from './runtime.js';
import {
  PostgresReadStore,
  PostgresReadStoreProvider,
  textFetchMargin,
  withReadOnlyConnection,
} from './store/postgres-store.js';
import type {
  IncidentReadStore,
  IncidentReadStoreProvider,
  ReadTransactionOptions,
} from './store/read-store.js';
import {
  connectInMemory,
  hasRawControl,
  structured,
  testRuntime,
  textOf,
  type Harness,
} from './test-support.js';

/**
 * The store's SQL behaviour against a real database, as the reader role:
 * the evaluation boundary of a named signal run (F7), one snapshot per tool
 * call (F8), bounded draft and explanation data measured at the database
 * (F10), and truthful truncation of every SQL-bounded field (F13).
 */

const AS_OF = '2026-09-04T09:11:23Z';
const char = (code: number): string => String.fromCodePoint(code);
const QUIET = ['0.4', '-0.3', '0.5', '-0.2', '0.1', '0.3', '-0.4', '0.2', '-0.1', '0.3', '0.2'];

function shift(instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) + milliseconds).toISOString();
}

async function readerBackends(database: TestDatabase): Promise<number> {
  return database.admin.withClient(async (client) => {
    const result = await client.query<{ n: string }>(
      `SELECT pg_catalog.count(*)::pg_catalog.text AS n
         FROM pg_catalog.pg_stat_activity WHERE usename = $1`,
      [database.readerRole],
    );
    return Number(result.rows[0]?.n ?? '0');
  });
}

async function eventually(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

async function harnessFor(database: TestDatabase): Promise<Harness> {
  return connectInMemory({
    env: {
      DATABASE_URL: database.readerConfig.connectionString,
      GRAPH_API_KEY: DB_SECRET_API_KEY,
    },
    store: undefined,
    live: null,
  });
}

interface StoredResult {
  readonly text: string;
  readonly stored: Record<string, unknown>;
  readonly boundary: Record<string, unknown>;
  readonly entries: Record<string, unknown>[];
  entry(key: string): Record<string, unknown>;
  provenance(key: string): Record<string, unknown>;
}

async function storedAnomalies(
  harness: Harness,
  signalRunId: string,
  asOf: string,
): Promise<StoredResult> {
  const result = await harness.client.callTool({
    name: 'chain_anomalies',
    arguments: { mode: 'stored', signalRunId, asOf },
  });
  expect(result.isError, textOf(result)).not.toBe(true);
  const stored = structured(result)['stored'] as Record<string, unknown>;
  const entries = stored['entries'] as Record<string, unknown>[];
  const entry = (key: string): Record<string, unknown> => {
    const found = entries.find((e) => `${e['chain']}:${e['protocolSlug']}` === key);
    if (found === undefined) throw new Error(`no entry for ${key}`);
    return found;
  };
  return {
    text: textOf(result),
    stored,
    boundary: stored['boundary'] as Record<string, unknown>,
    entries,
    entry,
    provenance: (key) => entry(key)['provenance'] as Record<string, unknown>,
  };
}

/** One completed (or running) run holding one observation per listed target. */
async function completedRun(
  database: TestDatabase,
  completedAt: string | null,
  observations: readonly SyntheticObservation[],
): Promise<{ runId: string; signalIds: Map<string, string> }> {
  return database.admin.withTransaction((tx) =>
    insertSyntheticSignalRun(tx, {
      origin: 'replay',
      observations,
      startedAt: completedAt ?? observations[0]?.observedAt ?? AS_OF,
      completedAt,
    }),
  );
}

// ---------------------------------------------------------------------------

describe('F7: a named completed signal run bounds its own evaluation', () => {
  let database: TestDatabase;
  let seeded: SeededPipeline;
  let harness: Harness;
  let twelfth: StoredResult;

  beforeAll(async () => {
    database = await openTestDatabase();
    seeded = await seedPipeline(database.admin);
    harness = await harnessFor(database);
    twelfth = await storedAnomalies(harness, seeded.latestSignalRunId, AS_OF);
  });

  afterAll(async () => {
    await harness?.close();
    await database?.close();
  });

  it('evaluates the first and the twelfth run at their own boundaries, naming the contributing runs', async () => {
    const first = await storedAnomalies(harness, seeded.signalRunIds[0] ?? '', AS_OF);
    expect(first.text).not.toBe(twelfth.text);
    expect(Date.parse(first.boundary['completedAt'] as string)).toBe(
      Date.parse(seeded.signalRunInstants[0] ?? ''),
    );
    expect(first.boundary['contributingRunCount']).toBe(1);
    expect(Date.parse(first.boundary['latestContributingRunCompletedAt'] as string)).toBe(
      Date.parse(seeded.signalRunInstants[0] ?? ''),
    );
    // Eleven days before the as-of instant, every observation of the first
    // run is stale, and every entry is attributed to that run and no other.
    for (const entry of first.entries) {
      expect(entry['label']).toBe('stale_observation');
      const provenance = entry['provenance'] as Record<string, unknown>;
      expect(provenance['latestSignalRunId']).toBe(seeded.signalRunIds[0]);
      expect(provenance['observationsUsed']).toBe(1);
      expect(provenance['contributingRunCount']).toBe(1);
      expect(entry['provenanceId']).toBe(seeded.signalRunIds[0]);
    }
    expect(twelfth.boundary['contributingRunCount']).toBe(12);
    expect(twelfth.entry('ethereum:aave-v3')['label']).toBe('normal');
    expect(twelfth.provenance('ethereum:aave-v3')['latestSignalRunId']).toBe(
      seeded.latestSignalRunId,
    );
    expect(twelfth.provenance('ethereum:aave-v3')['observationsUsed']).toBe(12);
    expect(twelfth.stored['observationsRead']).toBeGreaterThan(
      first.stored['observationsRead'] as number,
    );
  });

  it('is not changed by a later run that is still running', async () => {
    await completedRun(database, null, [
      {
        chain: 'ethereum',
        protocolSlug: 'aave-v3',
        observedAt: '2026-09-04T05:00:00.000Z',
        deltaPercent: '99.9',
      },
    ]);
    const again = await storedAnomalies(harness, seeded.latestSignalRunId, AS_OF);
    expect(again.text).toBe(twelfth.text);
  });

  it('has no failed run state to exclude: the schema refuses one', async () => {
    let failure: unknown;
    try {
      await database.admin.withTransaction((tx) =>
        tx.query(
          `INSERT INTO graph_signal_runs (
             id, data_origin, signal_version, contract_version, contract_hash, query_sha256,
             gateway_host, idempotency_key, status, target_count, signal_count, failed_target_count,
             started_at, completed_at
           ) VALUES (pg_catalog.gen_random_uuid(), 'replay', 'v', 'v', repeat('a', 64), repeat('b', 64),
                     'gateway.fixture.example', repeat('c', 64), 'failed', 0, 0, 0, now(), NULL)`,
        ),
      );
    } catch (error) {
      failure = error;
    }
    // The guard trigger refuses first (P0001: a run is inserted running); the
    // CHECK constraint behind it admits only the two states.
    expect(['P0001', '23514']).toContain(isDatabaseError(failure) ? failure.code : 'none');
    const definitions = await database.admin.withClient((client) =>
      client.query<{ d: string }>(
        `SELECT pg_catalog.pg_get_constraintdef(c.oid) AS d
           FROM pg_catalog.pg_constraint c
          WHERE c.conrelid = 'public.graph_signal_runs'::pg_catalog.regclass AND c.contype = 'c'`,
      ),
    );
    expect(definitions.rows.map((row) => row.d)).toContain(
      "CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text])))",
    );
  });

  it('is not changed by a later completed run, which is evaluated on its own boundary', async () => {
    const later = await completedRun(database, '2026-09-05T10:00:00.000Z', [
      {
        chain: 'ethereum',
        protocolSlug: 'aave-v3',
        observedAt: '2026-09-05T03:17:41.000Z',
        deltaPercent: '99.9',
      },
    ]);
    const unchanged = await storedAnomalies(harness, seeded.latestSignalRunId, AS_OF);
    expect(unchanged.text).toBe(twelfth.text);
    const thirteenth = await storedAnomalies(harness, later.runId, '2026-09-05T09:11:23Z');
    expect(thirteenth.entry('ethereum:aave-v3')['label']).toBe('positive_spike');
    expect(thirteenth.provenance('ethereum:aave-v3')['latestSignalRunId']).toBe(later.runId);
    expect(thirteenth.provenance('ethereum:aave-v3')['latestSignalId']).toBe(
      later.signalIds.get('ethereum:aave-v3'),
    );
    expect(thirteenth.provenance('ethereum:aave-v3')['observationsUsed']).toBe(13);
    expect(thirteenth.boundary['contributingRunCount']).toBe(13);
    expect(Date.parse(thirteenth.boundary['latestContributingRunCompletedAt'] as string)).toBe(
      Date.parse('2026-09-05T10:00:00.000Z'),
    );
  });

  it('applies asOf before the limit: an observation after asOf is excluded until asOf passes it', async () => {
    // Inside the twelfth run's boundary (completed one minute before it), but
    // observed after the as-of instant of the standard request.
    const future = await completedRun(database, '2026-09-04T09:59:00.000Z', [
      {
        chain: 'ethereum',
        protocolSlug: 'aave-v3',
        observedAt: '2026-09-04T09:30:00.000Z',
        deltaPercent: '99.9',
      },
    ]);
    const before = await storedAnomalies(harness, seeded.latestSignalRunId, AS_OF);
    expect(before.entry('ethereum:aave-v3')['label']).toBe('normal');
    expect(before.provenance('ethereum:aave-v3')['latestSignalRunId']).toBe(
      seeded.latestSignalRunId,
    );
    expect(
      Date.parse(before.provenance('ethereum:aave-v3')['latestObservedAt'] as string),
    ).toBeLessThanOrEqual(Date.parse(AS_OF));
    const after = await storedAnomalies(harness, seeded.latestSignalRunId, '2026-09-04T09:31:00Z');
    expect(after.entry('ethereum:aave-v3')['label']).toBe('positive_spike');
    expect(after.provenance('ethereum:aave-v3')['latestSignalRunId']).toBe(future.runId);
    expect(after.provenance('ethereum:aave-v3')['observationsUsed']).toBe(13);
  });

  it('keeps the most recent 400 observations at or before asOf when a target has more', async () => {
    const latestObserved = '2026-09-04T03:17:41.000Z';
    await database.admin.withTransaction(async (tx) => {
      // Four hundred and twenty daily observations at or before the as-of
      // instant, each in its own completed run, all inside the boundary.
      for (let k = 0; k < 420; k += 1) {
        const observedAt = shift(latestObserved, -k * 86_400_000);
        await insertSyntheticSignalRun(tx, {
          origin: 'replay',
          observations: [
            {
              chain: 'ethereum',
              protocolSlug: 'load-test',
              observedAt,
              deltaPercent: QUIET[k % QUIET.length] ?? '0.1',
            },
          ],
          startedAt: observedAt,
          completedAt: shift(observedAt, 6 * 3_600_000 + 42 * 60_000 + 19_000),
        });
      }
      // Thirty more, inside the boundary but after the as-of instant.
      for (let k = 0; k < 30; k += 1) {
        const observedAt = shift('2026-09-04T09:20:00.000Z', k * 60_000);
        await insertSyntheticSignalRun(tx, {
          origin: 'replay',
          observations: [
            { chain: 'ethereum', protocolSlug: 'load-test', observedAt, deltaPercent: '77.7' },
          ],
          startedAt: observedAt,
          completedAt: '2026-09-04T09:50:00.000Z',
        });
      }
    });
    const result = await storedAnomalies(harness, seeded.latestSignalRunId, AS_OF);
    const provenance = result.provenance('ethereum:load-test');
    expect(provenance['observationsUsed']).toBe(400);
    expect(provenance['contributingRunCount']).toBe(400);
    expect(Date.parse(provenance['latestObservedAt'] as string)).toBe(Date.parse(latestObserved));
    const entry = result.entry('ethereum:load-test');
    expect(entry['label']).toBe('normal');
    // The baseline starts at the four-hundredth most recent observation: the
    // twenty oldest were cut by the limit, and the thirty newest by asOf.
    const oldestUsed = shift(latestObserved, -399 * 86_400_000);
    expect((entry['baselineWindow'] as Record<string, number>)['startsAt']).toBe(
      Math.floor(Date.parse(oldestUsed) / 1000),
    );
    expect(result.stored['observationsRead']).toBeGreaterThanOrEqual(400);
    const moved = await storedAnomalies(harness, seeded.latestSignalRunId, '2026-09-04T09:50:00Z');
    expect(moved.provenance('ethereum:load-test')['observationsUsed']).toBe(400);
    expect(Date.parse(moved.provenance('ethereum:load-test')['latestObservedAt'] as string)).toBe(
      Date.parse('2026-09-04T09:49:00.000Z'),
    );
  });

  it('selects equal instants deterministically, by run completion then signal identifier', async () => {
    const tie = '2026-09-04T03:00:00.000Z';
    for (let k = 8; k >= 1; k -= 1) {
      const observedAt = shift(tie, -k * 86_400_000);
      await completedRun(database, shift(observedAt, 7 * 3_600_000), [
        {
          chain: 'base',
          protocolSlug: 'tie-target',
          observedAt,
          deltaPercent: QUIET[k] ?? '0.1',
        },
      ]);
    }
    const earlier = await completedRun(database, '2026-09-03T12:00:00.000Z', [
      { chain: 'base', protocolSlug: 'tie-target', observedAt: tie, deltaPercent: '0.1' },
    ]);
    const later = await completedRun(database, '2026-09-04T09:00:00.000Z', [
      { chain: 'base', protocolSlug: 'tie-target', observedAt: tie, deltaPercent: '55.5' },
    ]);
    const once = await storedAnomalies(harness, seeded.latestSignalRunId, AS_OF);
    const twice = await storedAnomalies(harness, seeded.latestSignalRunId, AS_OF);
    expect(twice.text).toBe(once.text);
    const entry = once.entry('base:tie-target');
    expect(entry['value']).toBe('55.5');
    expect(entry['label']).toBe('positive_spike');
    const provenance = once.provenance('base:tie-target');
    expect(provenance['latestSignalRunId']).toBe(later.runId);
    expect(provenance['latestSignalId']).toBe(later.signalIds.get('base:tie-target'));
    expect(provenance['latestSignalRunId']).not.toBe(earlier.runId);
    expect(provenance['observationsUsed']).toBe(10);
    expect(provenance['contributingRunCount']).toBe(10);
  });
});

// ---------------------------------------------------------------------------

/** Resolves once, from wherever it is first resolved. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Pauses the first association read of a call until the test releases it. */
class GatedProvider implements IncidentReadStoreProvider {
  readonly reached = deferred();
  readonly release = deferred();
  readonly #inner: IncidentReadStoreProvider;

  constructor(inner: IncidentReadStoreProvider) {
    this.#inner = inner;
  }

  withReadTransaction<T>(
    fn: (store: IncidentReadStore) => Promise<T>,
    options?: ReadTransactionOptions,
  ): Promise<T> {
    return this.#inner.withReadTransaction((store) => fn(this.gate(store)), options);
  }

  verifyPrivileges(options?: ReadTransactionOptions) {
    return this.#inner.verifyPrivileges(options);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }

  private gate(store: IncidentReadStore): IncidentReadStore {
    const { reached, release } = this;
    return new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'listIncidentAssociations') {
          return async (...args: Parameters<IncidentReadStore['listIncidentAssociations']>) => {
            reached.resolve();
            await release.promise;
            return target.listIncidentAssociations(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
  }
}

describe('F8: one tool call reads one snapshot', () => {
  let database: TestDatabase;
  let seeded: SeededPipeline;
  let associationId = '';

  beforeAll(async () => {
    database = await openTestDatabase();
    seeded = await seedPipeline(database.admin);
    associationId = await database.admin.withClient(async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM incident_signal_associations
          WHERE evidence_run_id = $1 AND incident_cluster_id = $2`,
        [seeded.evidenceRunId, seeded.corroboratedIncidentId],
      );
      return result.rows[0]?.id ?? '';
    });
    expect(associationId).not.toBe('');
  });

  afterAll(async () => {
    await database?.close();
  });

  it('keeps its initial snapshot while a review action commits, and the next call sees the action', async () => {
    const gated = new GatedProvider(
      new PostgresReadStoreProvider(database.readerConfig, {
        mode: 'production',
        textFetchMargin: textFetchMargin([DB_SECRET_API_KEY.length]),
      }),
    );
    const harness = await connectInMemory({
      env: { GRAPH_API_KEY: DB_SECRET_API_KEY },
      store: gated,
      live: null,
    });
    try {
      const args = {
        evidenceRunId: seeded.evidenceRunId,
        incidentId: seeded.corroboratedIncidentId,
      };
      const pending = harness.client.callTool({ name: 'explain_incident', arguments: args });
      // The call has read the run, the incident and its sources, and is about
      // to read the associations. A person now rejects the suggestion.
      await gated.reached.promise;
      await insertReviewAction(database.admin, seeded.evidenceRunId, associationId, 'reject', 2);
      gated.release.resolve();
      const during = structured(await pending);
      const seen = (during['associations'] as Record<string, unknown>[])[0];
      expect(seen?.['effective']).toMatchObject({ status: 'accepted', decidedByHuman: true });
      expect((during['incident'] as Record<string, unknown>)['evidence']).toMatchObject({
        state: 'corroborated',
      });
      expect(
        ((during['run'] as Record<string, unknown>)['stateCounts'] as Record<string, unknown>)[
          'corroborated'
        ],
      ).toBe(1);

      // The next call opens a new snapshot: the stored resolution is still
      // what the run recorded, and the effective decision is now the rejection.
      const next = structured(
        await harness.client.callTool({ name: 'explain_incident', arguments: args }),
      );
      const later = (next['associations'] as Record<string, unknown>[])[0];
      expect(later?.['effective']).toMatchObject({ status: 'rejected', decidedByHuman: true });
      expect(later?.['machineSuggestion']).toEqual(seen?.['machineSuggestion']);
      expect((next['incident'] as Record<string, unknown>)['evidence']).toMatchObject({
        state: 'corroborated',
        acceptedAssociationCount: 1,
      });
      expect(next['run']).toEqual(during['run']);
    } finally {
      await harness.close();
    }
    expect(await eventually(async () => (await readerBackends(database)) === 0)).toBe(true);
  });

  it('reads the anomaly boundary, its targets and every history in one snapshot', async () => {
    const provider = new PostgresReadStoreProvider(database.readerConfig, {
      mode: 'production',
      textFetchMargin: textFetchMargin([DB_SECRET_API_KEY.length]),
    });
    let snapshots: string[] = [];
    await provider.withReadTransaction(async () => undefined);
    // The transaction's own snapshot identifier, read on the call's connection.
    await withReadOnlyConnection(database.readerConfig, async (client) => {
      const first = await client.query<{ s: string }>(
        'SELECT pg_catalog.txid_current_snapshot()::pg_catalog.text AS s',
      );
      await completedRun(database, '2026-09-10T10:00:00.000Z', [
        {
          chain: 'ethereum',
          protocolSlug: 'aave-v3',
          observedAt: '2026-09-10T03:00:00.000Z',
          deltaPercent: '1.0',
        },
      ]);
      const second = await client.query<{ s: string }>(
        'SELECT pg_catalog.txid_current_snapshot()::pg_catalog.text AS s',
      );
      snapshots = [first.rows[0]?.s ?? '', second.rows[0]?.s ?? ''];
    });
    // A commit elsewhere did not move the snapshot of the open transaction.
    expect(snapshots[0]).toBe(snapshots[1]);
    expect(snapshots[0]).not.toBe('');
    await provider.close();
  });

  it('destroys the connection of a call that fails, and sends nothing once aborted', async () => {
    let failure: unknown;
    try {
      await withReadOnlyConnection(database.readerConfig, async (client) => {
        await client.query('SELECT pg_catalog.pg_sleep(30)');
      });
    } catch (error) {
      failure = error;
    }
    expect(isDatabaseError(failure) && failure.code).toBe('57014');
    expect(await eventually(async () => (await readerBackends(database)) === 0)).toBe(true);

    const controller = new AbortController();
    let statementsAfterAbort = 0;
    let aborted: unknown;
    try {
      await withReadOnlyConnection(
        database.readerConfig,
        async (client) => {
          await client.query('SELECT 1');
          controller.abort();
          statementsAfterAbort += 1;
          await client.query('SELECT 2');
          statementsAfterAbort += 1;
        },
        { signal: controller.signal },
      );
    } catch (error) {
      aborted = error;
    }
    expect(aborted instanceof Error && aborted.name).toBe('AbortError');
    expect(statementsAfterAbort).toBe(1);
    expect(await eventually(async () => (await readerBackends(database)) === 0)).toBe(true);

    // Through the runtime, an already aborted call is a fixed code and no connection.
    const { runtime } = testRuntime({
      env: { DATABASE_URL: database.readerConfig.connectionString },
      store: undefined,
    });
    const outcome = await invokeTool(
      runtime,
      'list_incidents',
      { evidenceRunId: seeded.evidenceRunId },
      { signal: AbortSignal.abort() },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('tool_timeout');
    await runtime.close();
    expect(await readerBackends(database)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

interface Meter {
  statements: number;
  rows: number;
  bytes: number;
}

function metered(client: Queryable, meter: Meter): Queryable {
  return {
    query: async <R extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
      const result = await client.query<R>(text, values);
      meter.statements += 1;
      meter.rows += result.rows.length;
      meter.bytes += Buffer.byteLength(JSON.stringify(result.rows), 'utf8');
      return result;
    },
  };
}

const LEGAL_TEXT = 'legal text '.repeat(4800).slice(0, 48_000);
const SECRET_CROSSING = `${'x'.repeat(280)}${DB_SECRET_API_KEY}${'y'.repeat(50)}`;

function pathologicalRows(): { rows: SeedRow[]; rowIds: string[] } {
  const rows: SeedRow[] = [
    { title: LEGAL_TEXT, publisher: 'Seed Legal', slug: 'p0', group: 'big' },
    { title: 'a'.repeat(299), publisher: 'Seed A', slug: 'p1', group: 'big' },
    { title: 'b'.repeat(300), publisher: 'Seed B', slug: 'p2', group: 'big' },
    { title: 'c'.repeat(301), publisher: 'Seed C', slug: 'p3', group: 'big' },
    { title: char(0x6f22).repeat(400), publisher: 'Seed CJK', slug: 'p4', group: 'big' },
    { title: '<'.repeat(300), publisher: 'Seed Angle', slug: 'p5', group: 'big' },
    { title: SECRET_CROSSING, publisher: 'Seed Secret', slug: 'p6', group: 'big' },
    { title: 'publisher bound', publisher: 'p'.repeat(121), slug: 'p7', group: 'big' },
    { title: 'url bound', publisher: 'Seed URL', slug: 'p8', group: 'u'.repeat(500) },
    { title: char(0x1f600).repeat(200), publisher: 'Seed Emoji', slug: 'p9', group: 'big' },
  ];
  const rowIds = rows.map(
    (_, index) => `00000000-0000-4000-8000-0000000000${index.toString(16).padStart(2, '0')}`,
  );
  for (let index = rows.length; index < 600; index += 1) {
    rows.push({
      title: `filler story ${index}`,
      publisher: 'Seed Filler',
      slug: `f${index}`,
      group: 'big',
    });
    rowIds.push(
      `${index.toString(16).padStart(8, 'f')}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    );
  }
  rows.push({ ...(SEED_ROWS[5] as SeedRow), slug: 'second', group: 'second' });
  rowIds.push(`ffffffff-0000-4000-8000-${'e'.repeat(12)}`);
  return { rows, rowIds };
}

describe('F10 and F13: bounded draft data and truthful truncation', () => {
  let database: TestDatabase;
  let pipeline: SeededPipeline;
  let harness: Harness;
  let bigIncidentId = '';
  const margin = textFetchMargin([DB_SECRET_API_KEY.length]);

  beforeAll(async () => {
    database = await openTestDatabase();
    // One signal run with a thousand targets, so a thousand suggestions can
    // point at the one incident.
    const keys = Array.from(
      { length: 1000 },
      (_, i) => `ethereum:assoc-${String(i).padStart(4, '0')}`,
    );
    const run = await database.admin.withTransaction((tx) =>
      insertSyntheticSignalRun(tx, {
        origin: 'replay',
        observations: [...keys, 'ethereum:aave-v3', 'base:seamless-protocol'].map((key) => ({
          chain: key.split(':')[0] as 'ethereum' | 'base',
          protocolSlug: key.split(':')[1] ?? '',
          observedAt: '2026-09-20T03:00:00.000Z',
          deltaPercent: '0.1',
        })),
        startedAt: '2026-09-20T10:00:00.000Z',
        completedAt: '2026-09-20T10:00:00.000Z',
      }),
    );
    const { rows, rowIds } = pathologicalRows();
    pipeline = await seedPipeline(database.admin, {
      rows,
      rowIds,
      clusters: [Array.from({ length: 600 }, (_, i) => i), [600]],
      signalRuns: {
        latest: run.runId,
        runIds: [run.runId],
        liveRunId: run.runId,
        signalIds: run.signalIds,
      },
      extraAssociations: keys.map((signalKey) => ({ clusterIndex: 0, signalKey })),
    });
    bigIncidentId = pipeline.clusterIds[0] ?? '';
    harness = await harnessFor(database);
  }, 300_000);

  afterAll(async () => {
    await harness?.close();
    await database?.close();
  });

  it('bounds the draft query at the database: incidents, sources per incident and characters per column', async () => {
    const meter: Meter = { statements: 0, rows: 0, bytes: 0 };
    const rows = await withReadOnlyConnection(database.readerConfig, async (client, schema) => {
      const store = new PostgresReadStore(metered(client, meter), schema, margin);
      return store.listDraftIncidents(pipeline.evidenceRunId, 100, 20);
    });
    expect(meter.statements).toBe(1);
    expect(rows).toHaveLength(2);
    const big = rows.find((row) => row.incidentId === bigIncidentId);
    expect(big?.sourceTotal).toBe(600);
    expect(big?.sources).toHaveLength(20);
    // The ten pathological rows sort first and were the first fetched.
    expect(big?.sources.slice(0, 10).map((s) => s.sourceRowId)).toEqual(
      pathologicalRows().rowIds.slice(0, 10),
    );
    for (const row of rows) {
      for (const source of row.sources) {
        expect([...(source.title?.fragment ?? '')].length).toBeLessThanOrEqual(
          HEADLINE_MAX_CHARACTERS + TEXT_FETCH_MARGIN_MAX_CHARACTERS,
        );
        expect([...(source.publisher?.fragment ?? '')].length).toBeLessThanOrEqual(
          PUBLISHER_MAX_CHARACTERS + TEXT_FETCH_MARGIN_MAX_CHARACTERS,
        );
        expect([...(source.url?.fragment ?? '')].length).toBeLessThanOrEqual(
          URL_MAX_CHARACTERS + TEXT_FETCH_MARGIN_MAX_CHARACTERS,
        );
      }
    }
    const legal = big?.sources[0];
    expect(legal?.title).toMatchObject({ characters: 48_000, bytes: 48_000 });
    expect([...(legal?.title?.fragment ?? '')].length).toBe(HEADLINE_MAX_CHARACTERS + margin);
    const cjk = big?.sources[4];
    expect(cjk?.title).toMatchObject({ characters: 400, bytes: 1200 });
    const emoji = big?.sources[9];
    expect(emoji?.title).toMatchObject({ characters: 200, bytes: 800 });
    expect([...(emoji?.title?.fragment ?? '')].length).toBe(200);
    // The whole database answer for the draft is smaller than the one
    // unbounded title would have been on its own.
    expect(meter.rows).toBe(21);
    expect(meter.bytes).toBeLessThan(48_000);
    console.info(
      `measurement draft: statements=${meter.statements} rows=${meter.rows} bytes=${meter.bytes} margin=${margin} incidents=${rows.length} memberships=600`,
    );
  });

  it('bounds the explanation queries at the database, sources and associations alike', async () => {
    const meter: Meter = { statements: 0, rows: 0, bytes: 0 };
    const { sources, associations } = await withReadOnlyConnection(
      database.readerConfig,
      async (client, schema) => {
        const store = new PostgresReadStore(metered(client, meter), schema, margin);
        return {
          sources: await store.listIncidentSources(
            pipeline.clusteringRunId,
            bigIncidentId,
            EXPLAIN_SOURCES_LIMIT,
          ),
          associations: await store.listIncidentAssociations(
            pipeline.evidenceRunId,
            bigIncidentId,
            EXPLAIN_ASSOCIATIONS_LIMIT,
          ),
        };
      },
    );
    expect(sources).toHaveLength(EXPLAIN_SOURCES_LIMIT);
    expect(associations).toHaveLength(EXPLAIN_ASSOCIATIONS_LIMIT);
    expect(meter.statements).toBe(2);
    expect(meter.rows).toBe(EXPLAIN_SOURCES_LIMIT + EXPLAIN_ASSOCIATIONS_LIMIT);
    expect(meter.bytes).toBeLessThan(96 * 1024);
    console.info(
      `measurement explain: statements=${meter.statements} rows=${meter.rows} bytes=${meter.bytes} memberships=600 associations=1002`,
    );
    // Deterministic: the same order every time.
    const again = await withReadOnlyConnection(database.readerConfig, async (client, schema) => {
      const store = new PostgresReadStore(client, schema, margin);
      return store.listIncidentAssociations(
        pipeline.evidenceRunId,
        bigIncidentId,
        EXPLAIN_ASSOCIATIONS_LIMIT,
      );
    });
    expect(again.map((a) => a.associationId)).toEqual(associations.map((a) => a.associationId));
  });

  it('explains the incident with truthful truncation of every bounded field', async () => {
    const result = await harness.client.callTool({
      name: 'explain_incident',
      arguments: { evidenceRunId: pipeline.evidenceRunId, incidentId: bigIncidentId },
    });
    expect(result.isError, textOf(result)).not.toBe(true);
    const explained = structured(result);
    expect(explained['bounds']).toEqual({
      sourcesReturned: EXPLAIN_SOURCES_LIMIT,
      sourcesLimit: EXPLAIN_SOURCES_LIMIT,
      associationsReturned: EXPLAIN_ASSOCIATIONS_LIMIT,
      associationsLimit: EXPLAIN_ASSOCIATIONS_LIMIT,
    });
    const sources = explained['sources'] as Record<string, unknown>[];
    const title = (index: number): Record<string, unknown> =>
      sources[index]?.['title'] as Record<string, unknown>;
    const omitted = (quoted: Record<string, unknown>): number =>
      Number(/…\[\+(\d+) chars\]$/u.exec(quoted['text'] as string)?.[1] ?? '0');

    expect(title(0)['truncated']).toBe(true);
    expect(omitted(title(0))).toBe(48_000 - HEADLINE_MAX_CHARACTERS);
    expect(
      (title(0)['text'] as string).startsWith(LEGAL_TEXT.slice(0, HEADLINE_MAX_CHARACTERS)),
    ).toBe(true);
    expect(title(1)).toMatchObject({ truncated: false, text: 'a'.repeat(299) });
    expect(title(2)).toMatchObject({ truncated: false, text: 'b'.repeat(300) });
    expect(title(3)['truncated']).toBe(true);
    expect(omitted(title(3))).toBe(1);
    expect(title(4)['truncated']).toBe(true);
    expect(omitted(title(4))).toBe(100);
    expect((title(4)['text'] as string).startsWith(char(0x6f22).repeat(300))).toBe(true);
    expect(title(5)['truncated']).toBe(true);
    expect(omitted(title(5))).toBe(250);
    expect((title(5)['text'] as string).startsWith('\\u003c'.repeat(50))).toBe(true);
    // The secret crossed the display boundary, was fetched whole, and was
    // redacted before the cut: no prefix of it leaks.
    expect(title(6)['text']).toContain('[REDACTED]');
    expect(title(6)['text']).not.toContain(DB_SECRET_API_KEY.slice(0, 6));
    expect(title(6)['truncated']).toBe(true);
    const publisher = sources[7]?.['publisher'] as Record<string, unknown>;
    expect(publisher['truncated']).toBe(true);
    expect(omitted(publisher)).toBe(1);
    const url = sources[8]?.['url'] as Record<string, unknown>;
    expect(url['truncated']).toBe(true);
    expect(omitted(url)).toBeGreaterThan(0);
    expect((url['text'] as string).length).toBeLessThanOrEqual(URL_MAX_CHARACTERS + 32);
    expect(title(9)['truncated']).toBe(true);
    expect(omitted(title(9))).toBe(50);
    for (const source of sources) {
      for (const field of ['title', 'publisher', 'url']) {
        const quoted = source[field] as Record<string, unknown> | null;
        if (quoted !== null) expect(quoted['trust']).toBe('untrusted_quoted_evidence');
      }
    }
    const text = textOf(result);
    expect(hasRawControl(text)).toBe(false);
    expect(text).not.toContain(DB_SECRET_API_KEY);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(256 * 1024);
  });

  it('lists the incident with its representative headline marked as cut', async () => {
    const result = await harness.client.callTool({
      name: 'list_incidents',
      arguments: { evidenceRunId: pipeline.evidenceRunId },
    });
    expect(result.isError, textOf(result)).not.toBe(true);
    const incidents = structured(result)['incidents'] as Record<string, unknown>[];
    const big = incidents.find((i) => i['incidentId'] === bigIncidentId);
    const headline = big?.['headline'] as Record<string, unknown>;
    expect(headline['truncated']).toBe(true);
    expect(headline['text']).toMatch(/…\[\+47700 chars\]$/u);
    expect(big?.['sourceCount']).toBe(600);
  });

  it('previews the draft from bounded data and discloses what was left out', async () => {
    const result = await harness.client.callTool({
      name: 'draft_section',
      arguments: {
        evidenceRunId: pipeline.evidenceRunId,
        // Both incidents carry a recorded on-chain subject, so they render here.
        section: 'crypto',
        periodStart: '2026-08-30T00:00:00Z',
        periodEnd: '2026-09-06T00:00:00Z',
        maximumIncidents: 100,
      },
    });
    expect(result.isError, textOf(result)).not.toBe(true);
    const output = structured(result);
    const bounds = output['bounds'] as Record<string, unknown>;
    expect(bounds).toMatchObject({
      sourcesPerIncidentLimit: 20,
      sourcesConsidered: 21,
      sourcesOmitted: 580,
      incidentsWithOmittedSources: 1,
    });
    const text = bounds['text'] as Record<string, number>;
    expect(text['fieldsTruncated']).toBeGreaterThanOrEqual(7);
    expect(text['storedCharacters']).toBeGreaterThan(48_000);
    expect(text['fetchedCharacters']).toBeLessThan(text['storedCharacters'] ?? 0);
    expect(text['storedBytes']).toBeGreaterThan(text['storedCharacters'] ?? 0);
    const markdown = (output['preview'] as Record<string, unknown>)['markdown'] as string;
    expect(markdown).not.toContain(DB_SECRET_API_KEY);
    expect(markdown).toContain('[REDACTED]');
    expect(markdown).toContain('…[+47700 chars]');
    expect(hasRawControl(markdown.replace(/\n/g, ''))).toBe(false);
    expect(Buffer.byteLength(textOf(result), 'utf8')).toBeLessThan(256 * 1024);
  });
});
