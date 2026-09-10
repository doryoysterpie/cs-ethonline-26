import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DataOrigin } from '@cas/contracts';
import { isDatabaseError, type Database } from '@cas/database';
import { EVIDENCE_REASON_CODES } from '@cas/evidence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { classifyBatch } from '../classification/run.js';
import { clusterClassificationRun } from '../clustering/run.js';
import { isIngestionError } from '../editorial/errors.js';
import { openMigratedSchema, type IsolatedSchema } from '../test-support.js';
import { buildAnomalyFeed } from './anomaly.js';
import { recordIncidentClaim } from './claim.js';
import { decideAssociation, evidenceReviewCounts } from './review.js';
import { reportEvidenceRun, resolveEvidence } from './run.js';
import {
  assertSnapshot,
  ingestLiveEvaluations,
  ingestSnapshotFile,
  type GraphClientIngestInput,
  type LiveTargetEvaluation,
} from './signals.js';
import { recordIncidentSubject } from './subject.js';

/**
 * The Sprint 5 evidence layer against a migrated PostgreSQL schema.
 *
 * Everything here runs against the real database, because most of what the
 * sprint claims is enforced by the schema rather than by TypeScript: composite
 * foreign keys that make a cross-run or cross-origin substitution unwritable,
 * triggers that freeze a completed run's output, a CHECK that refuses a
 * corroboration with nothing behind it, a claim guard that refuses a claim
 * from another incident, and the character policy on a rationale. A test that
 * mocked the database would prove none of it.
 *
 * The fixtures are the committed synthetic replay snapshots. The seeded rows
 * are invented; no organisation, headline or URL here is real.
 */

const FIXTURES = fileURLToPath(new URL('../../../../data/fixtures/evidence/', import.meta.url));

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);
const freshKey = (): string => randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64);

/**
 * A refusal raised by one of the migration guard triggers. They all use
 * `raise_exception`, and the driver reports the SQLSTATE rather than the
 * message, so the code is what a test can assert on.
 */
const raisedByGuard = (error: unknown): boolean => isDatabaseError(error) && error.code === 'P0001';
const foreignKeyRefused = (error: unknown): boolean =>
  isDatabaseError(error) && error.code === '23503';
const checkRefused = (error: unknown): boolean => isDatabaseError(error) && error.code === '23514';

function snapshotPath(day: number): string {
  return path.join(FIXTURES, 'snapshots', `replay-${String(day).padStart(2, '0')}.json`);
}

/**
 * Rows posted just before the replay window's last observation, so an
 * incident and a signal can fall inside the correlation window at all.
 */
const POSTED_AT = '2026-09-04T00:11:07.000Z';

const ROWS: readonly { title: string; summary: string; urlGroup: string }[] = [
  ...Array.from({ length: 12 }, (_, index) => ({
    title: `Company ${index} reports outage affecting services`,
    summary: `Officials described disruption to services and systems for customers in region ${index}. A security review followed.`,
    urlGroup: `bg-${index}`,
  })),
  {
    title: 'Ransomware halts Northwind Clinic radiology in Portland',
    summary:
      'Northwind Clinic Portland radiology systems were disrupted by the Volt Typhoon intrusion.',
    urlGroup: 'inc-a',
  },
  {
    title: 'Northwind Clinic Portland radiology disrupted by Volt Typhoon',
    summary: 'Volt Typhoon ransomware halted Northwind radiology systems in Portland.',
    urlGroup: 'inc-b',
  },
  {
    title: 'Kestrelvale Water district confirms a ransomware breach of billing systems',
    summary: 'Kestrelvale Water said billing was offline for two days after the ransomware breach.',
    urlGroup: 'syn-a',
  },
  {
    title: 'Eastvale Hospital pharmacy notice about a malware incident',
    summary: 'Eastvale Hospital pharmacy in Bridgeport described a malware incident on Tuesday.',
    urlGroup: 'dup-a',
  },
  {
    title: 'Larkmere Transit authority discloses a data breach of rider accounts',
    summary: 'Larkmere Transit said rider account data was exposed in a breach disclosed Friday.',
    urlGroup: 'brc',
  },
  {
    title: 'Stonebrook Credit Union reports an intrusion into member systems',
    summary: 'Stonebrook Credit Union described an intrusion affecting member systems last week.',
    urlGroup: 'cru',
  },
];

async function seedBatch(db: Database, label: string, origin: DataOrigin): Promise<string> {
  const batchId = randomUUID();
  const snapshotId = randomUUID();
  const groups = new Map<string, string>();
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO import_batches (
         id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
         header_cells, importer_version, idempotency_key, status, parsed_row_count,
         accepted_row_count, quarantined_row_count, started_at, completed_at
       ) VALUES ($1, $2, 'weekly', $3, 'seed.csv', $4, 10, '["ch"]'::jsonb,
                 'editorial-csv-import@1', $5, 'completed', $6, $6, 0, now(), now())`,
      [batchId, origin, label, hash('a'), freshKey(), ROWS.length],
    );
    await tx.query(
      `INSERT INTO review_snapshots (id, batch_id, review_label, data_origin, created_at)
       VALUES ($1, $2, $3, $4, now())`,
      [snapshotId, batchId, label, origin],
    );
    for (const [index, spec] of ROWS.entries()) {
      let groupId = groups.get(spec.urlGroup);
      if (groupId === undefined) {
        groupId = randomUUID();
        groups.set(spec.urlGroup, groupId);
        await tx.query(`INSERT INTO url_groups (id, canonical_url) VALUES ($1, $2)`, [
          groupId,
          `https://seed.example/${label}/${spec.urlGroup}`,
        ]);
      }
      const rowId = randomUUID();
      await tx.query(
        `INSERT INTO source_rows (
           id, batch_id, row_number, data_origin, status, raw_cells, raw_fields, raw_ch,
           raw_url, raw_category, posted_at, normalized_title, derived_summary_text,
           text_transform, canonical_url, url_group_id, row_hash
         ) VALUES ($1, $2, $3, $4, 'accepted', '["TRUE"]'::jsonb, '{"ch":"TRUE"}'::jsonb,
                   'TRUE', $5, 'Security', $6::timestamptz, $7, $8, 'html-to-text@1', $5, $9, $10)`,
        [
          rowId,
          batchId,
          index + 1,
          origin,
          `https://seed.example/${label}/${spec.urlGroup}`,
          POSTED_AT,
          spec.title,
          spec.summary,
          groupId,
          hash(String(index % 10)),
        ],
      );
      await tx.query(
        `INSERT INTO review_entries (id, snapshot_id, source_row_id, batch_id, raw_value, review_state)
         VALUES ($1, $2, $3, $4, 'TRUE', 'selected')`,
        [randomUUID(), snapshotId, rowId, batchId],
      );
    }
  });
  return batchId;
}

interface Subjects {
  readonly spark: string;
  readonly compound: string;
  readonly maker: string;
  readonly aave: string;
  readonly unnamed: string;
}

/** A synthetic, fully valid Graph-client evaluation. Nothing here is a real response. */
function liveEvaluation(
  chain: 'ethereum' | 'base',
  slug: string,
  queriedAtUtc: string,
  querySha256: string,
  overrides: Partial<{
    valid: boolean;
    fresh: boolean;
    mismatches: unknown[];
    origin: DataOrigin;
    providerBase: string;
    queryDocumentSha256: string;
  }> = {},
): LiveTargetEvaluation {
  const queried = Math.floor(Date.parse(queriedAtUtc) / 1000);
  return {
    target: {
      chain,
      slug: `${slug}-${chain}`,
      expectedProviderSlug: slug,
      subgraphId: `Syn${'a'.repeat(40)}`,
    },
    valid: overrides.valid ?? true,
    failure: null,
    mismatches: overrides.mismatches ?? [],
    freshness: { fresh: overrides.fresh ?? true },
    signal: {
      protocol: { slug, chain },
      current: {
        timestamp: queried - 3600,
        blockNumber: 21_000_000,
        totalValueLockedUsd: '1050.5',
      },
      baseline: { timestamp: queried - 3600 - 86_400, totalValueLockedUsd: '1000.0' },
      elapsedSeconds: 86_400,
      deltaUsd: '50.5',
      deltaPercent: '5.05',
      provenance: {
        origin: overrides.origin ?? 'live',
        providerBase: overrides.providerBase ?? 'https://gateway.thegraph.com/api',
        deploymentId: 'QmSyntheticDeployment',
        queriedAtUtc,
        queryDocumentSha256: overrides.queryDocumentSha256 ?? querySha256,
        block: { number: 21_000_000, hash: `0x${'a'.repeat(64)}` },
      },
    },
  };
}

/** A database handle that refuses every use, so a test can prove nothing touched it. */
function untouchableDatabase(): Database {
  const refuse = (): never => {
    throw new Error('the database was used');
  };
  return {
    withClient: refuse,
    withTransaction: refuse,
    end: async () => undefined,
  } as unknown as Database;
}

describe('the evidence layer against a migrated schema', () => {
  let isolated: IsolatedSchema;
  let clusteringRunId = '';
  const signalRunIds: string[] = [];
  let subjects: Subjects;
  let temporary = '';

  async function memberRow(incidentId: string): Promise<string> {
    const row = await isolated.db.withClient((client) =>
      client.query<{ source_row_id: string }>(
        `SELECT source_row_id FROM incident_memberships
          WHERE clustering_run_id = $1 AND incident_cluster_id = $2 ORDER BY source_row_id LIMIT 1`,
        [clusteringRunId, incidentId],
      ),
    );
    const id = row.rows[0]?.source_row_id;
    if (id === undefined) throw new Error('incident has no member');
    return id;
  }

  beforeAll(async () => {
    isolated = await openMigratedSchema();
    const batchId = await seedBatch(isolated.db, 'CS90', 'replay');
    const classified = await classifyBatch(isolated.db, { batchId });
    const clustered = await clusterClassificationRun(isolated.db, {
      classificationRunId: classified.run.id,
    });
    clusteringRunId = clustered.run.id;

    for (let day = 1; day <= 12; day += 1) {
      const outcome = await ingestSnapshotFile(isolated.db, {
        kind: 'file',
        snapshotPath: snapshotPath(day),
        dataOrigin: 'replay',
      });
      signalRunIds.push(outcome.run.id);
    }

    const incidents = await isolated.db.withClient((client) =>
      client.query<{ id: string }>(
        `SELECT id FROM incident_clusters WHERE clustering_run_id = $1 ORDER BY id LIMIT 5`,
        [clusteringRunId],
      ),
    );
    const [a, b, c, d, e] = incidents.rows.map((row) => row.id);
    if (
      a === undefined ||
      b === undefined ||
      c === undefined ||
      d === undefined ||
      e === undefined
    ) {
      throw new Error('the seed did not produce five incidents');
    }
    subjects = { spark: a, compound: b, maker: c, aave: d, unnamed: e };
    temporary = await mkdtemp(path.join(os.tmpdir(), 'cas-evidence-'));
  });

  afterAll(async () => {
    await isolated.close();
  });

  const dayRun = (day: number): string => {
    const id = signalRunIds[day - 1];
    if (id === undefined) throw new Error(`no signal run for day ${day}`);
    return id;
  };

  // ------------------------------------------------------------- ingestion

  it('ingests a replay snapshot once and treats a repeat as the same run', async () => {
    const repeat = await ingestSnapshotFile(isolated.db, {
      kind: 'file',
      snapshotPath: snapshotPath(12),
      dataOrigin: 'replay',
    });
    expect(repeat.outcome).toBe('already_ingested');
    expect(repeat.run.id).toBe(dayRun(12));
    const runs = await isolated.db.withClient((client) =>
      client.query<{ count: string }>(`SELECT count(*)::text FROM graph_signal_runs`),
    );
    expect(runs.rows[0]?.count).toBe('12');
  });

  it('never conflates the same bytes read under two origins', async () => {
    const asFixture = await ingestSnapshotFile(isolated.db, {
      kind: 'file',
      snapshotPath: snapshotPath(12),
      dataOrigin: 'fixture',
    });
    expect(asFixture.outcome).toBe('ingested');
    expect(asFixture.run.id).not.toBe(dayRun(12));
    expect(asFixture.run.dataOrigin).toBe('fixture');
    // And the replay history stays a replay history: the fixture rows are a
    // separate series for the same target, not extra observations in it.
    const history = await isolated.db.withClient((client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text FROM graph_signals
          WHERE chain = 'ethereum' AND protocol_slug = 'aave-v3' AND data_origin = 'replay'`,
      ),
    );
    expect(history.rows[0]?.count).toBe('12');
  });

  it('refuses to ingest a file as live before the file or the database is touched', async () => {
    // A path that does not exist: had the file been opened first, the error
    // would be the structural `snapshot_unreadable`, not this one. A database
    // that throws on any use: had a handle been used, the test would see it.
    const missing = path.join(temporary, 'does-not-exist.json');
    let caught: unknown;
    try {
      await ingestSnapshotFile(untouchableDatabase(), {
        kind: 'file',
        snapshotPath: missing,
        dataOrigin: 'live' as unknown as 'replay',
      });
    } catch (error) {
      caught = error;
    }
    expect(isIngestionError(caught)).toBe(true);
    expect(isIngestionError(caught) ? caught.code : '').toBe('origin_not_file_backed');
    expect(isIngestionError(caught) ? caught.kind : '').toBe('configuration');
    const runs = await isolated.db.withClient((client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text FROM graph_signal_runs WHERE data_origin = 'live'`,
      ),
    );
    expect(runs.rows[0]?.count).toBe('0');
  });

  it('refuses a file input that is not exactly a file input', async () => {
    for (const input of [
      { kind: 'graph-client', snapshotPath: snapshotPath(1), dataOrigin: 'replay' },
      { kind: 'file', snapshotPath: snapshotPath(1), dataOrigin: 'replay', origin: 'live' },
      { kind: 'file', snapshotPath: snapshotPath(1) },
      Object.assign(Object.create({ dataOrigin: 'replay' }) as object, {
        kind: 'file',
        snapshotPath: snapshotPath(1),
      }),
    ]) {
      await expect(ingestSnapshotFile(untouchableDatabase(), input as never)).rejects.toSatisfy(
        (error: unknown) => isIngestionError(error),
      );
    }
  });

  it('ingests validated Graph-client evaluations as a live run, with no path and no origin flag', async () => {
    const queriedAtUtc = '2026-09-04T09:00:00.000Z';
    const query = hash('c');
    const input: GraphClientIngestInput = {
      kind: 'graph-client',
      queriedAtUtc,
      gatewayHost: 'gateway.thegraph.com',
      querySha256: query,
      evaluations: [
        liveEvaluation('ethereum', 'aave-v3', queriedAtUtc, query),
        liveEvaluation('base', 'moonwell', queriedAtUtc, query),
      ],
    };
    const outcome = await ingestLiveEvaluations(isolated.db, input);
    expect(outcome.outcome).toBe('ingested');
    expect(outcome.run.dataOrigin).toBe('live');
    expect(outcome.run.gatewayHost).toBe('gateway.thegraph.com');
    expect(outcome.signalCount).toBe(2);
    const signals = await isolated.db.withClient((client) =>
      client.query<{ data_origin: string; count: string }>(
        `SELECT data_origin, count(*)::text FROM graph_signals WHERE signal_run_id = $1 GROUP BY 1`,
        [outcome.run.id],
      ),
    );
    expect(signals.rows).toEqual([{ data_origin: 'live', count: '2' }]);
    // The same evaluations again are the same run.
    const again = await ingestLiveEvaluations(isolated.db, input);
    expect(again.outcome).toBe('already_ingested');
    expect(again.run.id).toBe(outcome.run.id);
  });

  it('refuses Graph-client input that is not fully validated live evidence', async () => {
    const queriedAtUtc = '2026-09-04T09:00:00.000Z';
    const query = hash('c');
    const base = (
      evaluation: LiveTargetEvaluation,
      host = 'gateway.thegraph.com',
    ): GraphClientIngestInput => ({
      kind: 'graph-client',
      queriedAtUtc,
      gatewayHost: host,
      querySha256: query,
      evaluations: [evaluation],
    });
    const at = (overrides: Parameters<typeof liveEvaluation>[4]): LiveTargetEvaluation =>
      liveEvaluation('ethereum', 'aave-v3', queriedAtUtc, query, overrides);
    const cases: readonly [string, GraphClientIngestInput][] = [
      ['not valid', base(at({ valid: false }))],
      ['stale', base(at({ fresh: false }))],
      ['identity mismatch', base(at({ mismatches: [{}] }))],
      ['replay provenance', base(at({ origin: 'replay' }))],
      ['another query', base(at({ queryDocumentSha256: hash('d') }))],
      ['served by another host', base(at({ providerBase: 'https://other.example.org/api' }))],
      [
        'reserved host',
        base(
          at({ providerBase: 'https://gateway.fixture.example/api' }),
          'gateway.fixture.example',
        ),
      ],
      [
        'credential in base',
        base(at({ providerBase: 'https://user:key@gateway.thegraph.com/api' })),
      ],
    ];
    for (const [label, input] of cases) {
      let caught: unknown;
      try {
        await ingestLiveEvaluations(untouchableDatabase(), input);
      } catch (error) {
        caught = error;
      }
      expect(isIngestionError(caught), label).toBe(true);
      expect(isIngestionError(caught) ? caught.code : '', label).toBe('live_evaluation_invalid');
    }
  });

  it('cannot bind an evidence run to a signal run or clustering run of another origin', async () => {
    const clustering = await isolated.db.withClient((client) =>
      client.query<{ batch_id: string }>(`SELECT batch_id FROM clustering_runs WHERE id = $1`, [
        clusteringRunId,
      ]),
    );
    const attempt = (dataOrigin: string, signalRunId: string): Promise<unknown> =>
      isolated.db.withClient((client) =>
        client.query(
          `INSERT INTO evidence_runs (
             id, clustering_run_id, batch_id, signal_run_id, data_origin, resolver_version,
             contract_version, contract_hash, idempotency_key, status, incident_count, signal_count,
             suggestion_count, reported_only_count, onchain_observed_count, corroborated_count,
             contradicted_count, started_at
           ) VALUES ($1, $2, $3, $4, $5, 'evidence-resolver@1', 'evidence-behavior-contract@1', $6,
                     $7, 'running', 0, 0, 0, 0, 0, 0, 0, now())`,
          [
            randomUUID(),
            clusteringRunId,
            clustering.rows[0]?.batch_id,
            signalRunId,
            dataOrigin,
            hash('e'),
            freshKey(),
          ],
        ),
      );
    // A live evidence run over a replay signal run and a replay clustering run.
    await expect(attempt('live', dayRun(12))).rejects.toSatisfy(foreignKeyRefused);
    // A replay evidence run over the live signal run recorded above.
    const live = await isolated.db.withClient((client) =>
      client.query<{ id: string }>(
        `SELECT id FROM graph_signal_runs WHERE data_origin = 'live' LIMIT 1`,
      ),
    );
    await expect(attempt('replay', live.rows[0]?.id ?? '')).rejects.toSatisfy(foreignKeyRefused);
  });

  it('cannot record a live signal run served from a reserved-domain host', async () => {
    await expect(
      isolated.db.withClient((client) =>
        client.query(
          `INSERT INTO graph_signal_runs (
             id, data_origin, signal_version, contract_version, contract_hash, query_sha256,
             gateway_host, idempotency_key, status, target_count, signal_count, failed_target_count,
             started_at
           ) VALUES ($1, 'live', 'standardized-tvl-signal@1', 'evidence-behavior-contract@1', $2, $2,
                     'gateway.fixture.example', $3, 'running', 1, 0, 0, now())`,
          [randomUUID(), hash('f'), freshKey()],
        ),
      ),
    ).rejects.toSatisfy(checkRefused);
  });

  it('accepts a reordered snapshot as the same snapshot', async () => {
    const original = JSON.parse(await readFile(snapshotPath(11), 'utf8')) as {
      observations: unknown[];
    };
    const reordered = { ...original, observations: [...original.observations].reverse() };
    const file = path.join(temporary, 'reordered.json');
    await writeFile(file, JSON.stringify(reordered), 'utf8');
    const outcome = await ingestSnapshotFile(isolated.db, {
      kind: 'file',
      snapshotPath: file,
      dataOrigin: 'replay',
    });
    expect(outcome.outcome).toBe('already_ingested');
    expect(outcome.run.id).toBe(dayRun(11));
  });

  it('refuses every malformed snapshot before a row is written', async () => {
    const cases: readonly [string, unknown][] = [
      ['not an object', ['a']],
      [
        'unknown key',
        { gatewayHost: 'g.example', querySha256: hash('0'), observations: [], extra: 1 },
      ],
      [
        'host with a scheme',
        { gatewayHost: 'https://g.example', querySha256: hash('0'), observations: [] },
      ],
      [
        'host with credentials',
        { gatewayHost: 'user:secret@g.example', querySha256: hash('0'), observations: [] },
      ],
      [
        'digest not hexadecimal',
        { gatewayHost: 'g.example', querySha256: 'nope', observations: [] },
      ],
      ['no observations', { gatewayHost: 'g.example', querySha256: hash('0'), observations: [] }],
    ];
    for (const [label, value] of cases) {
      expect(() => assertSnapshot(value), label).toThrowError();
    }
  });

  it('refuses a snapshot that names one target twice', async () => {
    const observation = {
      chain: 'ethereum',
      protocolSlug: 'aave-v3',
      subgraphDeploymentId: null,
      blockNumber: 1,
      blockHash: null,
      observedAt: POSTED_AT,
      baselineObservedAt: POSTED_AT,
      currentTvlUsd: '1',
      baselineTvlUsd: '1',
      deltaUsd: '0',
      deltaPercent: '0',
    };
    expect(() =>
      assertSnapshot({
        gatewayHost: 'g.example',
        querySha256: hash('0'),
        observations: [observation, { ...observation }],
      }),
    ).toThrowError();
  });

  it('accepts a zero movement and an extreme one, and refuses an unrepresentable one', () => {
    const base = {
      chain: 'ethereum',
      protocolSlug: 'aave-v3',
      subgraphDeploymentId: null,
      blockNumber: 0,
      blockHash: null,
      observedAt: POSTED_AT,
      baselineObservedAt: POSTED_AT,
      currentTvlUsd: '0',
      baselineTvlUsd: '0',
      deltaUsd: '0',
    };
    const wrap = (deltaPercent: string): unknown => ({
      gatewayHost: 'g.example',
      querySha256: hash('0'),
      observations: [{ ...base, deltaPercent }],
    });
    expect(assertSnapshot(wrap('0')).observations[0]?.deltaPercent).toBe('0');
    expect(assertSnapshot(wrap('-99999999999999999999999999999.999999')).observations).toHaveLength(
      1,
    );
    expect(() => assertSnapshot(wrap('1e9'))).toThrowError();
    expect(() => assertSnapshot(wrap('NaN'))).toThrowError();
    expect(() => assertSnapshot(wrap('Infinity'))).toThrowError();
  });

  // -------------------------------------------------------------- subjects

  it('records an incident subject and refuses a disagreeing second one', async () => {
    const first = await recordIncidentSubject(isolated.db, {
      clusteringRunId,
      incidentId: subjects.spark,
      chain: 'ethereum',
      protocolSlug: 'spark-lend',
      actor: 'owner',
      reasonCode: 'named_in_disclosure',
    });
    expect(first.outcome).toBe('recorded');
    const repeat = await recordIncidentSubject(isolated.db, {
      clusteringRunId,
      incidentId: subjects.spark,
      chain: 'ethereum',
      protocolSlug: 'spark-lend',
      actor: 'owner',
      reasonCode: 'named_in_disclosure',
    });
    expect(repeat.outcome).toBe('already_recorded');
    await expect(
      recordIncidentSubject(isolated.db, {
        clusteringRunId,
        incidentId: subjects.spark,
        chain: 'base',
        protocolSlug: 'moonwell',
        actor: 'owner',
        reasonCode: 'named_in_disclosure',
      }),
    ).rejects.toMatchObject({ code: 'subject_conflict' });
  });

  it('refuses a subject for an incident that is not in the clustering run', async () => {
    await expect(
      recordIncidentSubject(isolated.db, {
        clusteringRunId,
        incidentId: randomUUID(),
        chain: 'ethereum',
        protocolSlug: 'aave-v3',
        actor: 'owner',
        reasonCode: 'named_in_disclosure',
      }),
    ).rejects.toMatchObject({ code: 'incident_not_found' });
  });

  it('keeps a recorded subject append-only', async () => {
    for (const statement of [
      `UPDATE incident_subjects SET protocol_slug = 'moonwell' WHERE clustering_run_id = $1`,
      `DELETE FROM incident_subjects WHERE clustering_run_id = $1`,
    ]) {
      await expect(
        isolated.db.withClient((client) => client.query(statement, [clusteringRunId])),
      ).rejects.toSatisfy(raisedByGuard);
    }
  });

  // ---------------------------------------------------------------- claims

  it('records a claim resting on a member source row, once', async () => {
    const sourceRowId = await memberRow(subjects.spark);
    const first = await recordIncidentClaim(isolated.db, {
      clusteringRunId,
      incidentId: subjects.spark,
      sourceRowId,
      claimKind: 'recorded_statement',
      statement: 'The disclosure names a drain from the lending pool on the fourth.',
      actor: 'owner',
      reasonCode: 'stated_in_disclosure',
    });
    expect(first.outcome).toBe('recorded');
    expect(first.claim.dataOrigin).toBe('replay');
    expect(first.claim.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    const again = await recordIncidentClaim(isolated.db, {
      clusteringRunId,
      incidentId: subjects.spark,
      sourceRowId,
      claimKind: 'recorded_statement',
      statement: 'The disclosure names a drain from the lending pool on the fourth.',
      actor: 'owner',
      reasonCode: 'stated_in_disclosure',
    });
    expect(again.outcome).toBe('already_recorded');
    expect(again.claim.id).toBe(first.claim.id);
  });

  it('refuses a claim backed by a row that is not a member of the incident', async () => {
    const otherRow = await memberRow(subjects.compound);
    await expect(
      recordIncidentClaim(isolated.db, {
        clusteringRunId,
        incidentId: subjects.spark,
        sourceRowId: otherRow,
        claimKind: 'recorded_statement',
        statement: 'A statement about the wrong incident.',
        actor: 'owner',
        reasonCode: 'stated_in_disclosure',
      }),
    ).rejects.toMatchObject({ code: 'source_row_not_member' });
    // And the database refuses the same thing directly, without the service.
    const membership = await isolated.db.withClient((client) =>
      client.query<{ batch_id: string; row_hash: string }>(
        `SELECT batch_id, row_hash FROM incident_memberships
          WHERE clustering_run_id = $1 AND source_row_id = $2`,
        [clusteringRunId, otherRow],
      ),
    );
    await expect(
      isolated.db.withClient((client) =>
        client.query(
          `INSERT INTO incident_claims (
             id, clustering_run_id, batch_id, incident_cluster_id, data_origin, source_row_id,
             row_hash, claim_kind, statement, fingerprint, actor, reason_code, created_at
           ) VALUES ($1, $2, $3, $4, 'replay', $5, $6, 'recorded_statement', 'direct', $7, 'owner',
                     'stated_in_disclosure', now())`,
          [
            randomUUID(),
            clusteringRunId,
            membership.rows[0]?.batch_id,
            subjects.spark,
            otherRow,
            membership.rows[0]?.row_hash,
            hash('9'),
          ],
        ),
      ),
    ).rejects.toSatisfy(foreignKeyRefused);
  });

  it('refuses a claim statement outside the character policy, and an empty one', async () => {
    const sourceRowId = await memberRow(subjects.spark);
    for (const statement of ['', 'x'.repeat(281), `before${String.fromCodePoint(0x0a)}after`]) {
      await expect(
        recordIncidentClaim(isolated.db, {
          clusteringRunId,
          incidentId: subjects.spark,
          sourceRowId,
          claimKind: 'recorded_statement',
          statement,
          actor: 'owner',
          reasonCode: 'stated_in_disclosure',
        }),
      ).rejects.toSatisfy((error: unknown) => isIngestionError(error));
    }
  });

  it('keeps a recorded claim append-only', async () => {
    await expect(
      isolated.db.withClient((client) =>
        client.query(
          `UPDATE incident_claims SET statement = 'edited' WHERE clustering_run_id = $1`,
          [clusteringRunId],
        ),
      ),
    ).rejects.toSatisfy(raisedByGuard);
    await expect(
      isolated.db.withClient((client) =>
        client.query(`DELETE FROM incident_claims WHERE clustering_run_id = $1`, [clusteringRunId]),
      ),
    ).rejects.toSatisfy(raisedByGuard);
  });

  // ------------------------------------------------------------ resolution

  it('resolves every incident to reported_only while nothing is accepted', async () => {
    for (const [incidentId, slug] of [
      [subjects.compound, 'compound-v3'],
      [subjects.maker, 'makerdao'],
      [subjects.aave, 'aave-v3'],
    ] as const) {
      await recordIncidentSubject(isolated.db, {
        clusteringRunId,
        incidentId,
        chain: 'ethereum',
        protocolSlug: slug,
        actor: 'owner',
        reasonCode: 'named_in_disclosure',
      });
    }

    const outcome = await resolveEvidence(isolated.db, {
      clusteringRunId,
      signalRunId: dayRun(12),
    });
    expect(outcome.outcome).toBe('resolved');
    expect(outcome.run.status).toBe('completed');
    // spark-lend, compound-v3 and makerdao all moved past the five percent
    // floor on day twelve; aave-v3 moved 0.29 percent and is not suggested.
    expect(outcome.suggestions).toBe(3);

    const report = await reportEvidenceRun(isolated.db, outcome.run.id);
    expect(report.reconciled).toBe(true);
    expect(report.states.reportedOnly).toBe(report.states.total);
    expect(report.states.corroborated).toBe(0);
    expect(report.states.contradicted).toBe(0);
    expect(report.associations.suggested).toBe(3);
  });

  it('refuses to resolve a replay clustering run against a live signal run', async () => {
    const live = await isolated.db.withClient((client) =>
      client.query<{ id: string }>(
        `SELECT id FROM graph_signal_runs WHERE data_origin = 'live' LIMIT 1`,
      ),
    );
    // The service writes the run under the clustering run's origin; the
    // database refuses the mismatch with the signal run by foreign key.
    await expect(
      resolveEvidence(isolated.db, { clusteringRunId, signalRunId: live.rows[0]?.id ?? '' }),
    ).rejects.toSatisfy(foreignKeyRefused);
  });

  it('treats a replay with no new decision as the same resolution', async () => {
    const before = await isolated.db.withClient((client) =>
      client.query<{ count: string }>(`SELECT count(*)::text FROM evidence_runs`),
    );
    const outcome = await resolveEvidence(isolated.db, {
      clusteringRunId,
      signalRunId: dayRun(12),
    });
    expect(outcome.outcome).toBe('already_resolved');
    const after = await isolated.db.withClient((client) =>
      client.query<{ count: string }>(`SELECT count(*)::text FROM evidence_runs`),
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('binds every written row to the same run, batch, clustering run and signal run', async () => {
    const run = await isolated.db.withClient((client) =>
      client.query<{
        id: string;
        clustering_run_id: string;
        batch_id: string;
        signal_run_id: string;
      }>(
        `SELECT id, clustering_run_id, batch_id, signal_run_id FROM evidence_runs
          WHERE clustering_run_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [clusteringRunId],
      ),
    );
    const row = run.rows[0];
    expect(row).toBeDefined();
    const mismatched = await isolated.db.withClient((client) =>
      client.query<{ associations: string; states: string }>(
        `SELECT (SELECT count(*)::text FROM incident_signal_associations
                  WHERE evidence_run_id = $1
                    AND (clustering_run_id <> $2 OR batch_id <> $3 OR signal_run_id <> $4))
                AS associations,
                (SELECT count(*)::text FROM incident_evidence_states
                  WHERE evidence_run_id = $1
                    AND (clustering_run_id <> $2 OR batch_id <> $3 OR signal_run_id <> $4))
                AS states`,
        [row?.id, row?.clustering_run_id, row?.batch_id, row?.signal_run_id],
      ),
    );
    expect(mismatched.rows[0]).toEqual({ associations: '0', states: '0' });
  });

  it('cannot be made to point an association at another run’s incident', async () => {
    const association = await isolated.db.withClient((client) =>
      client.query<{ evidence_run_id: string; batch_id: string; signal_run_id: string }>(
        `SELECT evidence_run_id, batch_id, signal_run_id FROM incident_signal_associations LIMIT 1`,
      ),
    );
    const row = association.rows[0];
    expect(row).toBeDefined();
    const attempt = isolated.db.withClient((client) =>
      client.query(
        `INSERT INTO incident_signal_associations (
           id, evidence_run_id, clustering_run_id, batch_id, signal_run_id, incident_cluster_id,
           signal_id, chain, claim_id, relation, status, reason_codes, offset_seconds, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ethereum', NULL, 'context', 'suggested',
                   '["relevant_activity_observed"]'::jsonb, 0, now())`,
        [
          randomUUID(),
          row?.evidence_run_id,
          randomUUID(),
          row?.batch_id,
          row?.signal_run_id,
          subjects.spark,
          randomUUID(),
        ],
      ),
    );
    await expect(attempt).rejects.toSatisfy(foreignKeyRefused);
  });

  it('freezes a completed run and its output', async () => {
    const run = await isolated.db.withClient((client) =>
      client.query<{ id: string }>(
        `SELECT id FROM evidence_runs WHERE clustering_run_id = $1 LIMIT 1`,
        [clusteringRunId],
      ),
    );
    const runId = run.rows[0]?.id;
    await expect(
      isolated.db.withClient((client) =>
        client.query(`UPDATE evidence_runs SET suggestion_count = 99 WHERE id = $1`, [runId]),
      ),
    ).rejects.toSatisfy(raisedByGuard);
    await expect(
      isolated.db.withClient((client) =>
        client.query(
          `UPDATE incident_evidence_states SET state = 'corroborated' WHERE evidence_run_id = $1`,
          [runId],
        ),
      ),
    ).rejects.toSatisfy(raisedByGuard);
    await expect(
      isolated.db.withClient((client) =>
        client.query(
          `UPDATE incident_signal_associations SET status = 'accepted' WHERE evidence_run_id = $1`,
          [runId],
        ),
      ),
    ).rejects.toSatisfy(raisedByGuard);
  });

  // ---------------------------------------------------------------- review

  async function latestRun(): Promise<string> {
    const runRow = await isolated.db.withClient((client) =>
      client.query<{ id: string }>(
        `SELECT id FROM evidence_runs WHERE clustering_run_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [clusteringRunId],
      ),
    );
    return runRow.rows[0]?.id ?? '';
  }

  async function associationFor(runId: string, incidentId: string): Promise<string> {
    const rows = await isolated.db.withClient((client) =>
      client.query<{ id: string }>(
        `SELECT id FROM incident_signal_associations
          WHERE evidence_run_id = $1 AND incident_cluster_id = $2`,
        [runId, incidentId],
      ),
    );
    const id = rows.rows[0]?.id;
    if (id === undefined) throw new Error('no association for that incident');
    return id;
  }

  async function claimFor(incidentId: string, statement: string): Promise<string> {
    const outcome = await recordIncidentClaim(isolated.db, {
      clusteringRunId,
      incidentId,
      sourceRowId: await memberRow(incidentId),
      claimKind: 'recorded_statement',
      statement,
      actor: 'owner',
      reasonCode: 'stated_in_disclosure',
    });
    return outcome.claim.id;
  }

  it('moves an incident past reported_only only when a person accepts a real claim', async () => {
    const runId = await latestRun();
    const sparkClaim = await claimFor(
      subjects.spark,
      'The disclosure names a drain from the lending pool on the fourth.',
    );
    const compoundClaim = await claimFor(subjects.compound, 'The notice says no funds moved.');

    await decideAssociation(isolated.db, {
      runId,
      associationId: await associationFor(runId, subjects.spark),
      operation: 'accept',
      relation: 'supports',
      claimId: sparkClaim,
      reasonCode: 'movement_matches_disclosure',
      actor: 'owner',
      rationale: 'The disclosed window and the observed movement line up.',
    });
    await decideAssociation(isolated.db, {
      runId,
      associationId: await associationFor(runId, subjects.compound),
      operation: 'accept',
      relation: 'conflicts',
      claimId: compoundClaim,
      reasonCode: 'movement_contradicts_claim',
      actor: 'owner',
    });
    await decideAssociation(isolated.db, {
      runId,
      associationId: await associationFor(runId, subjects.maker),
      operation: 'accept',
      relation: 'context',
      reasonCode: 'activity_worth_noting',
      actor: 'owner',
    });

    const counts = await evidenceReviewCounts(isolated.db, runId);
    expect(counts).toMatchObject({ actions: 3, accepted: 3, rejected: 0, revision: 3 });

    // A decision changes what a resolution is, so resolving again is a new
    // run rather than the old one returned.
    const second = await resolveEvidence(isolated.db, {
      clusteringRunId,
      signalRunId: dayRun(12),
    });
    expect(second.outcome).toBe('resolved');
    expect(second.run.id).not.toBe(runId);
    const report = await reportEvidenceRun(isolated.db, second.run.id);
    expect(report.reconciled).toBe(true);
    expect(report.states.corroborated).toBe(1);
    expect(report.states.contradicted).toBe(1);
    expect(report.states.onchainObserved).toBe(1);

    const states = await isolated.db.withClient((client) =>
      client.query<{ incident_cluster_id: string; state: string; claim_id: string | null }>(
        `SELECT incident_cluster_id, state, claim_id FROM incident_evidence_states
          WHERE evidence_run_id = $1 AND state <> 'reported_only'`,
        [second.run.id],
      ),
    );
    const byIncident = new Map(states.rows.map((row) => [row.incident_cluster_id, row]));
    expect(byIncident.get(subjects.spark)?.state).toBe('corroborated');
    expect(byIncident.get(subjects.spark)?.claim_id).toBe(sparkClaim);
    expect(byIncident.get(subjects.compound)?.state).toBe('contradicted');
    expect(byIncident.get(subjects.compound)?.claim_id).toBe(compoundClaim);
    expect(byIncident.get(subjects.maker)?.state).toBe('onchain_observed');
    expect(byIncident.get(subjects.aave)).toBeUndefined();
  });

  it('refuses a decision naming a claim that does not exist, or belongs elsewhere', async () => {
    const runId = await latestRun();
    const association = await associationFor(runId, subjects.spark);
    const request = {
      runId,
      associationId: association,
      operation: 'accept' as const,
      relation: 'supports' as const,
      reasonCode: 'movement_matches_disclosure',
      actor: 'owner',
    };
    // Nonexistent.
    await expect(
      decideAssociation(isolated.db, { ...request, claimId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'claim_not_found' });
    // Another incident of the same run.
    const otherIncident = await claimFor(subjects.compound, 'A claim about the other incident.');
    await expect(
      decideAssociation(isolated.db, { ...request, claimId: otherIncident }),
    ).rejects.toMatchObject({ code: 'claim_incompatible' });
    // An association that is not this run's.
    await expect(
      decideAssociation(isolated.db, {
        ...request,
        associationId: randomUUID(),
        claimId: otherIncident,
      }),
    ).rejects.toMatchObject({ code: 'association_not_found' });
  });

  it('refuses a claim from another clustering run, batch and origin', async () => {
    // A second corpus under a different origin, its own classification and
    // clustering runs, its own incidents and its own claim.
    const batchId = await seedBatch(isolated.db, 'CS91', 'fixture');
    const classified = await classifyBatch(isolated.db, { batchId });
    const clustered = await clusterClassificationRun(isolated.db, {
      classificationRunId: classified.run.id,
    });
    const foreign = await isolated.db.withClient((client) =>
      client.query<{ incident: string; row: string }>(
        `SELECT incident_cluster_id AS incident, source_row_id AS row FROM incident_memberships
          WHERE clustering_run_id = $1 ORDER BY incident_cluster_id LIMIT 1`,
        [clustered.run.id],
      ),
    );
    const foreignClaim = await recordIncidentClaim(isolated.db, {
      clusteringRunId: clustered.run.id,
      incidentId: foreign.rows[0]?.incident ?? '',
      sourceRowId: foreign.rows[0]?.row ?? '',
      claimKind: 'reported_headline',
      statement: 'A headline from another batch.',
      actor: 'owner',
      reasonCode: 'reported_in_headline',
    });
    expect(foreignClaim.claim.dataOrigin).toBe('fixture');

    const runId = await latestRun();
    await expect(
      decideAssociation(isolated.db, {
        runId,
        associationId: await associationFor(runId, subjects.spark),
        operation: 'accept',
        relation: 'supports',
        claimId: foreignClaim.claim.id,
        reasonCode: 'movement_matches_disclosure',
        actor: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'claim_incompatible' });

    // And directly, past the service: the guard refuses an action citing it,
    // and the foreign key refuses a state citing it.
    const association = await isolated.db.withClient((client) =>
      client.query<{ id: string; batch_id: string; signal_run_id: string }>(
        `SELECT id, batch_id, signal_run_id FROM incident_signal_associations
          WHERE evidence_run_id = $1 AND incident_cluster_id = $2`,
        [runId, subjects.spark],
      ),
    );
    await expect(
      isolated.db.withClient((client) =>
        client.query(
          `INSERT INTO evidence_review_actions (
             id, evidence_run_id, association_id, operation, relation, claim_id, reason_code,
             rationale, actor, prior_revision, resulting_revision, idempotency_key, created_at
           ) VALUES ($1, $2, $3, 'accept', 'supports', $4, 'direct', NULL, 'owner', 900, 901, $5, now())`,
          [randomUUID(), runId, association.rows[0]?.id, foreignClaim.claim.id, freshKey()],
        ),
      ),
    ).rejects.toSatisfy(raisedByGuard);
    await expect(
      isolated.db.withClient((client) =>
        client.query(
          `INSERT INTO incident_evidence_states (
             id, evidence_run_id, clustering_run_id, batch_id, signal_run_id, incident_cluster_id,
             state, reason_code, claim_id, accepted_association_count, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'corroborated', 'accepted_supporting_association',
                     $7, 1, now())`,
          [
            randomUUID(),
            runId,
            clusteringRunId,
            association.rows[0]?.batch_id,
            association.rows[0]?.signal_run_id,
            subjects.spark,
            foreignClaim.claim.id,
          ],
        ),
      ),
    ).rejects.toSatisfy((error: unknown) => foreignKeyRefused(error) || raisedByGuard(error));
  });

  it('cannot record a supporting acceptance without a claim, even directly', async () => {
    const runId = await latestRun();
    const association = await associationFor(runId, subjects.spark);
    await expect(
      decideAssociation(isolated.db, {
        runId,
        associationId: association,
        operation: 'accept',
        relation: 'supports',
        reasonCode: 'movement_matches_disclosure',
        actor: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'claim_required' });
    await expect(
      isolated.db.withClient((client) =>
        client.query(
          `INSERT INTO evidence_review_actions (
             id, evidence_run_id, association_id, operation, relation, claim_id, reason_code,
             rationale, actor, prior_revision, resulting_revision, idempotency_key, created_at
           ) VALUES ($1, $2, $3, 'accept', 'supports', NULL, 'direct', NULL, 'owner', 900, 901, $4, now())`,
          [randomUUID(), runId, association, freshKey()],
        ),
      ),
    ).rejects.toSatisfy(raisedByGuard);
  });

  it('replays a decision deterministically, with the claim in its identity', async () => {
    // The run the supporting decision was recorded against, not the run a
    // later resolution produced from it.
    const action = await isolated.db.withClient((client) =>
      client.query<{
        evidence_run_id: string;
        association_id: string;
        reason_code: string;
        claim_id: string;
      }>(
        `SELECT evidence_run_id, association_id, reason_code, claim_id FROM evidence_review_actions
          WHERE operation = 'accept' AND relation = 'supports'
          ORDER BY created_at, resulting_revision LIMIT 1`,
      ),
    );
    const row = action.rows[0];
    expect(row).toBeDefined();
    const runId = row?.evidence_run_id ?? '';
    const request = {
      runId,
      associationId: row?.association_id ?? '',
      operation: 'accept' as const,
      relation: 'supports' as const,
      claimId: row?.claim_id ?? '',
      reasonCode: row?.reason_code ?? '',
      actor: 'owner',
      rationale: 'The disclosed window and the observed movement line up.',
    };
    const replay = await decideAssociation(isolated.db, request);
    expect(replay.outcome).toBe('already_recorded');

    // Same identity, different payload: a conflict, never a silent repeat.
    for (const changed of [
      { ...request, actor: 'someone_else' },
      { ...request, rationale: 'A different reason entirely.' },
      { ...request, rationale: null },
    ]) {
      await expect(decideAssociation(isolated.db, changed)).rejects.toMatchObject({
        code: 'evidence_action_conflict',
      });
    }

    // A different real claim is a different decision, recorded as its own
    // revision rather than confused with this one.
    const another = await claimFor(subjects.spark, 'A second statement the disclosure makes.');
    const before = await evidenceReviewCounts(isolated.db, runId);
    const recorded = await decideAssociation(isolated.db, { ...request, claimId: another });
    expect(recorded.outcome).toBe('recorded');
    expect(recorded.revision).toBe(before.revision + 1);
  });

  it('refuses a rationale carrying a prohibited character, at both boundaries', async () => {
    const runId = await latestRun();
    const associationId = await associationFor(runId, subjects.maker);
    // Generated from code points rather than typed, so the source file
    // itself stays free of the characters the policy refuses.
    const prohibited = [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f, 0x80, 0x9f, 0x2028, 0x2029].map(
      (code) => String.fromCodePoint(code),
    );
    for (const character of prohibited) {
      await expect(
        decideAssociation(isolated.db, {
          runId,
          associationId,
          operation: 'reject',
          relation: 'context',
          reasonCode: 'not_related',
          actor: 'owner',
          rationale: `before${character}after`,
        }),
      ).rejects.toSatisfy((error: unknown) => isIngestionError(error));

      // The same policy again in the database, because the worker API is not
      // the only way a row could arrive. A NUL never reaches the CHECK:
      // PostgreSQL text cannot hold one, so the driver refuses the value
      // first. Either refusal is the row not being written.
      await expect(
        isolated.db.withClient((client) =>
          client.query(
            `INSERT INTO evidence_review_actions (
               id, evidence_run_id, association_id, operation, relation, claim_id, reason_code,
               rationale, actor, prior_revision, resulting_revision, idempotency_key, created_at
             ) VALUES ($1, $2, $3, 'reject', 'context', NULL, 'not_related', $4, 'owner',
                       900, 901, $5, now())`,
            [randomUUID(), runId, associationId, `before${character}after`, freshKey()],
          ),
        ),
      ).rejects.toSatisfy(
        (error: unknown) =>
          isDatabaseError(error) && (error.code === '23514' || error.code === '22021'),
      );
    }
  });

  it('refuses a corroboration the database has nothing to rest on', async () => {
    const run = await isolated.db.withClient((client) =>
      client.query<{
        id: string;
        clustering_run_id: string;
        batch_id: string;
        signal_run_id: string;
      }>(
        `SELECT id, clustering_run_id, batch_id, signal_run_id FROM evidence_runs
          WHERE clustering_run_id = $1 LIMIT 1`,
        [clusteringRunId],
      ),
    );
    const row = run.rows[0];
    const realClaim = await claimFor(subjects.unnamed, 'A claim with nothing accepted behind it.');
    for (const [label, count, claim] of [
      ['no accepted association', 0, realClaim],
      ['no claim', 1, null],
    ] as const) {
      await expect(
        isolated.db.withClient((client) =>
          client.query(
            `INSERT INTO incident_evidence_states (
               id, evidence_run_id, clustering_run_id, batch_id, signal_run_id,
               incident_cluster_id, state, reason_code, claim_id, accepted_association_count,
               created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, 'corroborated', 'accepted_supporting_association',
                       $7, $8, now())`,
            [
              randomUUID(),
              row?.id,
              row?.clustering_run_id,
              row?.batch_id,
              row?.signal_run_id,
              subjects.unnamed,
              claim,
              count,
            ],
          ),
        ),
        label,
      ).rejects.toThrowError();
    }
  });

  // --------------------------------------------------------------- anomaly

  it('builds the chain feed from stored replay rows, with every label it should have', async () => {
    const feed = await buildAnomalyFeed(isolated.db, {
      signalRunId: dayRun(12),
      now: () => new Date('2026-09-04T09:11:23Z'),
    });
    const labels = new Map(feed.entries.map((entry) => [entry.subjectId, entry.label]));
    expect(labels.get('ethereum:aave-v3')).toBe('normal');
    expect(labels.get('ethereum:spark-lend')).toBe('positive_spike');
    expect(labels.get('ethereum:compound-v3')).toBe('negative_spike');
    expect(labels.get('ethereum:makerdao')).toBe('positive_spike');
    expect(labels.get('ethereum:liquity')).toBe('insufficient_history');
    expect(labels.get('base:seamless-protocol')).toBe('missing_observation');
    // The target that stopped reporting is still in the feed, and is stale
    // rather than absent. A target that goes quiet is the case the label is
    // for; dropping it would be the failure it exists to catch.
    expect(labels.get('base:moonwell')).toBe('stale_observation');
    // Nothing from the live run above leaks into a replay feed.
    for (const entry of feed.entries) expect(entry.dataOrigin).toBe('replay');
    expect(feed.entries.filter((entry) => entry.signalType === 'chain_tvl')).toHaveLength(7);
  });

  it('refuses a reporting side with no explicit window', async () => {
    await expect(
      buildAnomalyFeed(isolated.db, { signalRunId: dayRun(12), clusteringRunId }),
    ).rejects.toMatchObject({ code: 'windows_required' });
  });

  it('counts a reporting window from the bounds it was given', async () => {
    const feed = await buildAnomalyFeed(isolated.db, {
      signalRunId: dayRun(12),
      clusteringRunId,
      windows: [
        { startsAt: '2026-08-14T00:00:00Z', endsAt: '2026-08-21T00:00:00Z' },
        { startsAt: '2026-08-21T00:00:00Z', endsAt: '2026-08-28T00:00:00Z' },
        { startsAt: '2026-08-28T00:00:00Z', endsAt: '2026-09-04T00:00:00Z' },
        { startsAt: '2026-09-04T00:00:00Z', endsAt: '2026-09-11T00:00:00Z' },
      ],
      now: () => new Date('2026-09-04T09:11:23Z'),
    });
    const reporting = feed.entries.filter((entry) => entry.signalType === 'reporting_volume');
    expect(reporting).toHaveLength(2);
    // Every seeded row is posted in the last window, so the three before it
    // are empty and the last one carries the whole corpus.
    expect(reporting.some((entry) => entry.label === 'positive_spike')).toBe(true);
    for (const entry of reporting) {
      expect(entry.evidenceLimitation).toContain('describes coverage, not incidents');
    }
  });

  it('reports a reason code from the fixed vocabulary or none at all', async () => {
    const feed = await buildAnomalyFeed(isolated.db, {
      signalRunId: dayRun(12),
      now: () => new Date('2026-09-04T09:11:23Z'),
    });
    const known = new Set(Object.values(EVIDENCE_REASON_CODES));
    for (const entry of feed.entries) {
      for (const code of entry.reasonCodes) expect(known.has(code)).toBe(true);
    }
  });
});
