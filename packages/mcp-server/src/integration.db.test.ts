import { isDatabaseError, openDatabase } from '@cas/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_SECRET_API_KEY,
  openTestDatabase,
  schemaDigest,
  seedPipeline,
  SEED_INSTANT,
  SEED_ROWS,
  type SeededPipeline,
  type TestDatabase,
} from './db-support.js';
import { withReadOnlyConnection } from './store/postgres-store.js';
import {
  connectInMemory,
  hasRawControl,
  structured,
  textOf,
  type Harness,
} from './test-support.js';

/**
 * Every tool against a migrated database, through the MCP client, as the
 * provisioned reader role in production mode, with the whole schema digested
 * before and after so the read-only claim is a measurement rather than an
 * assertion.
 */

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

describe('the MCP tools against a migrated database, as the reader role', () => {
  let database: TestDatabase;
  let seeded: SeededPipeline;
  let foreign: SeededPipeline;
  let harness: Harness;
  let before: Map<string, string>;

  beforeAll(async () => {
    database = await openTestDatabase();
    seeded = await seedPipeline(database.admin);
    foreign = await seedPipeline(database.admin, {
      rows: SEED_ROWS.slice(0, 4),
      signalRuns: {
        latest: seeded.latestSignalRunId,
        runIds: [...seeded.signalRunIds],
        liveRunId: seeded.liveSignalRunId,
        signalIds: new Map(seeded.signalIds),
        instants: [...seeded.signalRunInstants],
      },
    });
    before = await schemaDigest(database.admin, 'public');
    // The runtime builds its own provider from the reader's connection
    // string, exactly as the entry point does, in the default mode.
    harness = await connectInMemory({
      env: {
        DATABASE_URL: database.readerConfig.connectionString,
        GRAPH_API_KEY: DB_SECRET_API_KEY,
      },
      store: undefined,
      live: null,
    });
  });

  afterAll(async () => {
    await harness?.close();
    await database?.close();
  });

  it('seeded a completed pipeline the guards accepted, and runs in production mode as a verified reader', async () => {
    expect(seeded.incidentIds).toHaveLength(5);
    expect(seeded.signalRunIds).toHaveLength(12);
    expect(seeded.corroboratedIncidentId).not.toBe('');
    expect(seeded.observedIncidentId).not.toBe('');
    expect(foreign.incidentIds).toHaveLength(2);
    expect(harness.runtime.mode).toBe('production');
    expect(await harness.runtime.verifyDatabaseRole()).toEqual({
      status: 'verified',
      failed: [],
      errorCode: null,
    });
  });

  it('lists the run in pages, with origin, provenance and escaped headlines', async () => {
    const first = await harness.client.callTool({
      name: 'list_incidents',
      arguments: { evidenceRunId: seeded.evidenceRunId, limit: 2 },
    });
    expect(first.isError).not.toBe(true);
    const page = structured(first);
    const run = page['run'] as Record<string, unknown>;
    expect(run['dataOrigin']).toBe('replay');
    expect(run['clusteringRunId']).toBe(seeded.clusteringRunId);
    expect(run['signalRunId']).toBe(seeded.latestSignalRunId);
    expect((run['stateCounts'] as Record<string, unknown>)['corroborated']).toBe(1);
    const cursor = (page['page'] as Record<string, unknown>)['nextCursor'] as string;
    expect(cursor).toBeTruthy();
    const second = await harness.client.callTool({
      name: 'list_incidents',
      arguments: { evidenceRunId: seeded.evidenceRunId, limit: 50, afterIncidentId: cursor },
    });
    const rest = structured(second)['incidents'] as Record<string, unknown>[];
    expect(rest).toHaveLength(3);
    const all = [...(page['incidents'] as Record<string, unknown>[]), ...rest];
    expect(new Set(all.map((i) => i['incidentId']))).toEqual(new Set(seeded.incidentIds));
    const text = textOf(first) + textOf(second);
    expect(hasRawControl(text)).toBe(false);
    expect(text).not.toContain('<system>');
    expect(text).not.toContain(DB_SECRET_API_KEY);
    expect(text).not.toContain('derived body text');
    const corroborated = all.find((i) => i['incidentId'] === seeded.corroboratedIncidentId);
    expect((corroborated?.['evidence'] as Record<string, unknown>)['state']).toBe('corroborated');
    expect(corroborated?.['memberCount']).toBe(2);
    expect((corroborated?.['subject'] as Record<string, unknown>)['protocolSlug']).toBe('aave-v3');
    // Every headline was fetched whole and says so.
    for (const incident of all) {
      expect((incident['headline'] as Record<string, unknown>)['truncated']).toBe(false);
    }
  });

  it('explains an incident with its sources and the human decision beside the machine suggestion', async () => {
    const result = await harness.client.callTool({
      name: 'explain_incident',
      arguments: { evidenceRunId: seeded.evidenceRunId, incidentId: seeded.corroboratedIncidentId },
    });
    expect(result.isError).not.toBe(true);
    const explained = structured(result);
    const sources = explained['sources'] as Record<string, unknown>[];
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s['classificationDecision'])).toEqual(['include', 'include']);
    for (const source of sources) {
      for (const field of ['title', 'publisher', 'url']) {
        expect((source[field] as Record<string, unknown>)['truncated']).toBe(false);
      }
    }
    const associations = explained['associations'] as Record<string, unknown>[];
    expect(associations).toHaveLength(1);
    expect(associations[0]?.['machineSuggestion']).toEqual({
      relation: 'context',
      status: 'suggested',
      claimId: null,
    });
    expect(associations[0]?.['effective']).toMatchObject({
      relation: 'supports',
      status: 'accepted',
      decidedByHuman: true,
    });
    expect((associations[0]?.['effective'] as Record<string, unknown>)['claimId']).toBe(
      seeded.sourceRowIds[0],
    );
    const text = textOf(result);
    expect(text).not.toContain('A private note that must never leave');
    expect(text).not.toContain('seed.reviewer');
    expect(text).not.toContain('derived body text');
    expect(text).not.toContain('"actor"');
  });

  it('refuses cross-run access: an incident is visible only through the run that resolved it', async () => {
    const wrongRun = await harness.client.callTool({
      name: 'explain_incident',
      arguments: {
        evidenceRunId: foreign.evidenceRunId,
        incidentId: seeded.corroboratedIncidentId,
      },
    });
    expect(wrongRun.isError).toBe(true);
    expect(textOf(wrongRun)).toContain('incident_not_found');
    const foreignList = await harness.client.callTool({
      name: 'list_incidents',
      arguments: { evidenceRunId: foreign.evidenceRunId },
    });
    const ids = (structured(foreignList)['incidents'] as Record<string, unknown>[]).map(
      (i) => i['incidentId'],
    );
    expect(new Set(ids)).toEqual(new Set(foreign.incidentIds));
    for (const id of seeded.incidentIds) expect(ids).not.toContain(id);
    const unknownRun = await harness.client.callTool({
      name: 'list_incidents',
      arguments: { evidenceRunId: seeded.clusteringRunId },
    });
    expect(textOf(unknownRun)).toContain('evidence_run_not_found');
  });

  it('labels the replay signal run exactly as the fixtures say, from replay history inside its boundary', async () => {
    const result = await harness.client.callTool({
      name: 'chain_anomalies',
      arguments: {
        mode: 'stored',
        signalRunId: seeded.latestSignalRunId,
        asOf: '2026-09-04T09:11:23Z',
      },
    });
    expect(result.isError).not.toBe(true);
    const stored = structured(result)['stored'] as Record<string, unknown>;
    expect((stored['signalRun'] as Record<string, unknown>)['dataOrigin']).toBe('replay');
    const entries = stored['entries'] as Record<string, unknown>[];
    const labels = new Map(entries.map((e) => [`${e['chain']}:${e['protocolSlug']}`, e['label']]));
    expect(labels.get('ethereum:aave-v3')).toBe('normal');
    expect(labels.get('ethereum:spark-lend')).toBe('positive_spike');
    expect(labels.get('ethereum:compound-v3')).toBe('negative_spike');
    expect(labels.get('ethereum:makerdao')).toBe('positive_spike');
    expect(labels.get('ethereum:liquity')).toBe('insufficient_history');
    expect(labels.get('base:seamless-protocol')).toBe('missing_observation');
    expect(labels.get('base:moonwell')).toBe('stale_observation');
    for (const entry of entries) expect(entry['dataOrigin']).toBe('replay');
    // The live copy of the twelfth snapshot exists in the same tables and was not read:
    // aave-v3 would otherwise carry thirteen observations and a different label.
    expect(stored['targetsEvaluated']).toBe(7);
    // The boundary is the named run's completion; all twelve replay runs lie inside it.
    const boundary = stored['boundary'] as Record<string, unknown>;
    expect(Date.parse(boundary['completedAt'] as string)).toBe(
      Date.parse(seeded.signalRunInstants[11] ?? ''),
    );
    expect(boundary['contributingRunCount']).toBe(12);
    const aave = entries.find((e) => e['protocolSlug'] === 'aave-v3');
    expect((aave?.['provenance'] as Record<string, unknown>)['latestSignalRunId']).toBe(
      seeded.latestSignalRunId,
    );
    expect(aave?.['provenanceId']).toBe(seeded.latestSignalRunId);
  });

  it('labels the live-origin run from live history only, never from the replay series', async () => {
    const result = await harness.client.callTool({
      name: 'chain_anomalies',
      arguments: {
        mode: 'stored',
        signalRunId: seeded.liveSignalRunId,
        asOf: '2026-09-04T09:11:23Z',
      },
    });
    expect(result.isError).not.toBe(true);
    const stored = structured(result)['stored'] as Record<string, unknown>;
    expect((stored['signalRun'] as Record<string, unknown>)['dataOrigin']).toBe('live');
    const entries = stored['entries'] as Record<string, unknown>[];
    expect(entries.length).toBe(6);
    for (const entry of entries) {
      expect(entry['dataOrigin']).toBe('live');
      expect(entry['label']).toBe('insufficient_history');
      expect((entry['provenance'] as Record<string, unknown>)['contributingRunCount']).toBe(1);
    }
    expect(stored['observationsRead']).toBe(6);
    expect((stored['boundary'] as Record<string, unknown>)['contributingRunCount']).toBe(1);
  });

  it('previews every draft section without writing anything', async () => {
    for (const section of ['header', 'incidents', 'crypto', 'provenance'] as const) {
      const result = await harness.client.callTool({
        name: 'draft_section',
        arguments: {
          evidenceRunId: seeded.evidenceRunId,
          section,
          periodStart: '2026-08-30T00:00:00Z',
          periodEnd: '2026-09-06T00:00:00Z',
        },
      });
      expect(result.isError, section).not.toBe(true);
      const preview = structured(result)['preview'] as Record<string, unknown>;
      expect(preview['persisted']).toBe(false);
      expect(preview['modelInvoked']).toBe(false);
      const markdown = preview['markdown'] as string;
      expect(hasRawControl(markdown.replace(/\n/g, ''))).toBe(false);
      expect(markdown).not.toContain(DB_SECRET_API_KEY);
      expect(markdown).not.toContain('<system>');
      expect(structured(result)['bounds']).toMatchObject({
        sourcesOmitted: 0,
        incidentsWithOmittedSources: 0,
        sourcesConsidered: 6,
      });
    }
  });

  it('refuses malformed, duplicate-key and mixed-mode requests before any read', async () => {
    const malformed = await harness.client.callTool({
      name: 'explain_incident',
      arguments: {
        evidenceRunId: seeded.evidenceRunId,
        incidentId: "'; DROP TABLE source_rows; --",
      },
    });
    expect(malformed.isError).toBe(true);
    const mixed = await harness.client.callTool({
      name: 'chain_anomalies',
      arguments: { mode: 'live', chain: 'base', signalRunId: seeded.latestSignalRunId },
    });
    expect(mixed.isError).toBe(true);
    const duplicate = JSON.parse(
      `{"evidenceRunId":"${seeded.evidenceRunId}","evidenceRunId":"${foreign.evidenceRunId}"}`,
    ) as Record<string, unknown>;
    // JSON keeps the last duplicate key; the request then names the foreign run and nothing else.
    const answered = await harness.client.callTool({
      name: 'list_incidents',
      arguments: duplicate,
    });
    expect((structured(answered)['run'] as Record<string, unknown>)['evidenceRunId']).toBe(
      foreign.evidenceRunId,
    );
  });

  it('leaves every table byte-identical after all of the above, and no reader connection behind', async () => {
    const after = await schemaDigest(database.admin, 'public');
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [table, digest] of before) {
      expect(after.get(table), table).toBe(digest);
    }
    expect(before.size).toBeGreaterThanOrEqual(17);
    expect(await eventually(async () => (await readerBackends(database)) === 0)).toBe(true);
  });

  it('runs on a connection the database itself holds read-only, as a role that cannot write anyway', async () => {
    let failure: unknown;
    try {
      await withReadOnlyConnection(database.readerConfig, async (client) => {
        await client.query(`INSERT INTO url_groups (id, canonical_url) VALUES ($1, $2)`, [
          '00000000-0000-4000-8000-000000000000',
          'https://write.example/never',
        ]);
      });
    } catch (error) {
      failure = error;
    }
    expect(isDatabaseError(failure) && failure.code).toBe('25006');
    // Outside the read-only transaction the role itself lacks the privilege.
    const plain = openDatabase(database.readerConfig, { maxConnections: 1 });
    let denied: unknown;
    try {
      await plain.withClient((client) =>
        client.query(`INSERT INTO url_groups (id, canonical_url) VALUES ($1, $2)`, [
          '00000000-0000-4000-8000-000000000001',
          'https://write.example/never',
        ]),
      );
    } catch (error) {
      denied = error;
    } finally {
      await plain.end();
    }
    expect(isDatabaseError(denied) && denied.code).toBe('42501');
    const after = await schemaDigest(database.admin, 'public');
    expect(after.get('url_groups')).toBe(before.get('url_groups'));
  });

  it('cancels a statement that outlives the budget and destroys its connection', async () => {
    let failure: unknown;
    const started = Date.now();
    try {
      await withReadOnlyConnection(database.readerConfig, async (client) => {
        await client.query('SELECT pg_catalog.pg_sleep(30)');
      });
    } catch (error) {
      failure = error;
    }
    expect(isDatabaseError(failure) && failure.code).toBe('57014');
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(await eventually(async () => (await readerBackends(database)) === 0)).toBe(true);
    expect(Date.parse(SEED_INSTANT)).toBeGreaterThan(0);
  });
});
