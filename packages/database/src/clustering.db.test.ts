import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  completeClusteringRun,
  deriveClusteringCounts,
  getClusteringRun,
  insertIncidentClusters,
  insertIncidentMemberships,
  insertRunningClusteringRun,
  type NewClusteringRun,
  type NewIncidentCluster,
  type NewIncidentMembership,
} from './clustering.js';
import type { Database, Queryable } from './database.js';
import { isDatabaseError } from './errors.js';
import { runMigrations } from './migrate.js';
import { openIsolatedSchema, type IsolatedSchema } from './test-support.js';

/**
 * Persistence-level coverage of migration 0006. Every provenance contradiction
 * the composite keys forbid is attempted directly, and every way of completing
 * a run that does not describe its own stored output is refused.
 */

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);
const key = (): string => randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64);

interface Seeded {
  readonly batchId: string;
  readonly classificationRunId: string;
  readonly rowIds: readonly string[];
  readonly resultIds: readonly string[];
  readonly decisions: readonly string[];
}

/** One batch of three rows, classified: two eligible, one excluded. */
async function seed(db: Database, label: string): Promise<Seeded> {
  const batchId = randomUUID();
  const classificationRunId = randomUUID();
  const rowIds = [randomUUID(), randomUUID(), randomUUID()];
  const resultIds = [randomUUID(), randomUUID(), randomUUID()];
  const decisions = ['include', 'review', 'exclude'];
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO import_batches (
         id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
         header_cells, importer_version, idempotency_key, status, parsed_row_count,
         accepted_row_count, quarantined_row_count, started_at, completed_at
       ) VALUES ($1, 'replay', 'weekly', $2, 'seed.csv', $3, 10, '["ch"]'::jsonb,
                 'editorial-csv-import@1', $4, 'completed', 3, 3, 0, now(), now())`,
      [batchId, label, hash('a'), key()],
    );
    for (const [index, id] of rowIds.entries()) {
      await tx.query(
        `INSERT INTO source_rows (
           id, batch_id, row_number, data_origin, status, raw_cells, raw_fields,
           normalized_title, text_transform, row_hash
         ) VALUES ($1, $2, $3, 'replay', 'accepted', '["x"]'::jsonb, '{}'::jsonb,
                   $4, 'html-to-text@1', $5)`,
        [id, batchId, index + 1, `title ${index}`, hash(String(index))],
      );
    }
    await tx.query('UPDATE import_batches SET source_set_frozen_at = now() WHERE id = $1', [
      batchId,
    ]);
    await tx.query(
      `INSERT INTO classification_runs (
         id, batch_id, data_origin, classifier_version, ruleset_version, ruleset_hash, mode,
         idempotency_key, status, expected_row_count, classified_row_count, include_count,
         exclude_count, review_count, started_at, completed_at
       ) VALUES ($1, $2, 'replay', 'rules-classifier@3', 'contract@2', $3, 'rules', $4,
                 'running', 3, 0, 0, 0, 0, now(), NULL)`,
      [classificationRunId, batchId, hash('f'), key()],
    );
    for (const [index, id] of resultIds.entries()) {
      await tx.query(
        `INSERT INTO classification_results (
           id, run_id, batch_id, source_row_id, decision, rationale_codes, matched_signals,
           signal_score, row_hash, created_at
         ) VALUES ($1, $2, $3, $4, $5, '["decisive_signal"]'::jsonb, '[]'::jsonb, 0, $6, now())`,
        [id, classificationRunId, batchId, rowIds[index], decisions[index], hash(String(index))],
      );
    }
    await tx.query(
      `UPDATE classification_runs
          SET status = 'completed', classified_row_count = 3, include_count = 1,
              exclude_count = 1, review_count = 1, completed_at = now()
        WHERE id = $1`,
      [classificationRunId],
    );
  });
  return { batchId, classificationRunId, rowIds, resultIds, decisions };
}

function newRun(seeded: Seeded, overrides: Partial<NewClusteringRun> = {}): NewClusteringRun {
  return {
    id: randomUUID(),
    classificationRunId: seeded.classificationRunId,
    batchId: seeded.batchId,
    dataOrigin: 'replay',
    engineVersion: 'clustering-engine@1',
    contractVersion: 'clustering-behavior-contract@1',
    contractHash: hash('c'),
    idempotencyKey: key(),
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function newCluster(
  run: NewClusteringRun,
  fingerprint: string,
  memberCount: number,
  representative: string,
  overrides: Partial<NewIncidentCluster> = {},
): NewIncidentCluster {
  return {
    id: randomUUID(),
    clusteringRunId: run.id,
    batchId: run.batchId,
    fingerprint,
    kind: memberCount === 1 ? 'singleton' : 'duplicate_group',
    memberCount,
    duplicateGroupCount: 1,
    syndicationGroupCount: 1,
    reasonCodes: ['singleton_source'],
    representativeSourceRowId: representative,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function newMembership(
  run: NewClusteringRun,
  cluster: NewIncidentCluster,
  seeded: Seeded,
  index: number,
  overrides: Partial<NewIncidentMembership> = {},
): NewIncidentMembership {
  return {
    id: randomUUID(),
    clusteringRunId: run.id,
    incidentClusterId: cluster.id,
    batchId: run.batchId,
    dataOrigin: 'replay',
    sourceRowId: seeded.rowIds[index] ?? '',
    rowHash: hash(String(index)),
    classificationResultId: seeded.resultIds[index] ?? '',
    classificationRunId: seeded.classificationRunId,
    decision: seeded.decisions[index] ?? 'include',
    duplicateFingerprint: hash('d').slice(0, 32),
    syndicationFingerprint: hash('e').slice(0, 32),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function expectRejected(
  db: Database,
  attempt: (tx: Queryable) => Promise<unknown>,
): Promise<string> {
  let caught: unknown;
  try {
    await db.withTransaction(async (tx) => {
      await attempt(tx);
    });
  } catch (error) {
    caught = error;
  }
  expect(isDatabaseError(caught), 'PostgreSQL must reject the contradiction').toBe(true);
  if (!isDatabaseError(caught)) throw new Error('unreachable');
  return caught.code ?? '';
}

describe('clustering persistence (migration 0006)', () => {
  let isolated: IsolatedSchema;
  let batchA: Seeded;
  let batchB: Seeded;

  beforeAll(async () => {
    isolated = await openIsolatedSchema();
    await runMigrations(isolated.db);
    batchA = await seed(isolated.db, 'CS01');
    batchB = await seed(isolated.db, 'CS02');
  });

  afterAll(async () => {
    await isolated.close();
  });

  /** Writes a complete, correct run over batch A's two eligible results. */
  async function completeRun(seeded: Seeded): Promise<NewClusteringRun> {
    const run = newRun(seeded);
    await isolated.db.withTransaction(
      async (tx) => {
        await insertRunningClusteringRun(tx, run);
        const first = newCluster(run, hash('1').slice(0, 32), 1, seeded.rowIds[0] ?? '');
        const second = newCluster(run, hash('2').slice(0, 32), 1, seeded.rowIds[1] ?? '');
        await insertIncidentClusters(tx, [first, second]);
        await insertIncidentMemberships(tx, [
          newMembership(run, first, seeded, 0),
          newMembership(run, second, seeded, 1),
        ]);
        await completeClusteringRun(
          tx,
          run.id,
          await deriveClusteringCounts(tx, run.id, seeded.classificationRunId, [
            'include',
            'review',
          ]),
          new Date().toISOString(),
        );
      },
      { isolationLevel: 'repeatable read' },
    );
    return run;
  }

  it('stores a complete run whose counters describe its own output', async () => {
    const run = await completeRun(batchA);
    const stored = await isolated.db.withClient((c) => getClusteringRun(c, run.id));
    expect(stored?.status).toBe('completed');
    expect(stored?.eligibleRowCount).toBe(2);
    expect(stored?.ineligibleRowCount).toBe(1);
    expect(stored?.incidentCount).toBe(2);
    expect(stored?.singletonIncidentCount).toBe(2);
    expect(stored?.multiSourceIncidentCount).toBe(0);
    expect(stored?.largestClusterSize).toBe(1);
  });

  it('refuses a run inserted as already completed', async () => {
    const run = newRun(batchA);
    const code = await expectRejected(isolated.db, (tx) =>
      tx.query(
        `INSERT INTO clustering_runs (
           id, classification_run_id, batch_id, data_origin, engine_version, contract_version,
           contract_hash, idempotency_key, status, eligible_row_count, ineligible_row_count,
           duplicate_group_count, syndication_group_count, incident_count,
           singleton_incident_count, multi_source_incident_count, largest_cluster_size,
           ambiguous_link_count, started_at, completed_at
         ) VALUES ($1, $2, $3, 'replay', 'e', 'c', $4, $5, 'completed', 0, 0, 0, 0, 0, 0, 0, 0, 0,
                   now(), now())`,
        [run.id, run.classificationRunId, run.batchId, run.contractHash, run.idempotencyKey],
      ),
    );
    expect(code).toBe('P0001');
  });

  it('refuses every cross-batch and cross-run provenance contradiction', async () => {
    const run = newRun(batchA);
    const cluster = newCluster(run, hash('3').slice(0, 32), 1, batchA.rowIds[0] ?? '');

    // A cluster claiming a batch its run does not belong to.
    const crossBatchCluster = await expectRejected(isolated.db, async (tx) => {
      await insertRunningClusteringRun(tx, run);
      await insertIncidentClusters(tx, [{ ...cluster, batchId: batchB.batchId }]);
    });
    expect(crossBatchCluster).toBe('23503');

    // A membership whose source row belongs to another batch.
    const crossRow = await expectRejected(isolated.db, async (tx) => {
      await insertRunningClusteringRun(tx, run);
      await insertIncidentClusters(tx, [cluster]);
      await insertIncidentMemberships(tx, [
        newMembership(run, cluster, batchA, 0, { sourceRowId: batchB.rowIds[0] ?? '' }),
      ]);
    });
    expect(crossRow).toBe('23503');

    // A membership whose row hash is not that row's hash.
    const wrongHash = await expectRejected(isolated.db, async (tx) => {
      await insertRunningClusteringRun(tx, run);
      await insertIncidentClusters(tx, [cluster]);
      await insertIncidentMemberships(tx, [
        newMembership(run, cluster, batchA, 0, { rowHash: hash('9') }),
      ]);
    });
    expect(wrongHash).toBe('23503');

    // A membership whose classification result belongs to another run.
    const crossResult = await expectRejected(isolated.db, async (tx) => {
      await insertRunningClusteringRun(tx, run);
      await insertIncidentClusters(tx, [cluster]);
      await insertIncidentMemberships(tx, [
        newMembership(run, cluster, batchA, 0, {
          classificationResultId: batchB.resultIds[0] ?? '',
        }),
      ]);
    });
    expect(crossResult).toBe('23503');

    // A membership pointing at a cluster of a different clustering run.
    const otherRun = newRun(batchA);
    const crossCluster = await expectRejected(isolated.db, async (tx) => {
      await insertRunningClusteringRun(tx, run);
      await insertRunningClusteringRun(tx, otherRun);
      const otherCluster = newCluster(otherRun, hash('4').slice(0, 32), 1, batchA.rowIds[0] ?? '');
      await insertIncidentClusters(tx, [cluster, otherCluster]);
      await insertIncidentMemberships(tx, [
        newMembership(run, cluster, batchA, 0, { incidentClusterId: otherCluster.id }),
      ]);
    });
    expect(crossCluster).toBe('23503');
  });

  it('refuses two memberships for one source row in one run', async () => {
    const run = newRun(batchA);
    const cluster = newCluster(run, hash('5').slice(0, 32), 2, batchA.rowIds[0] ?? '');
    const code = await expectRejected(isolated.db, async (tx) => {
      await insertRunningClusteringRun(tx, run);
      await insertIncidentClusters(tx, [cluster]);
      await insertIncidentMemberships(tx, [
        newMembership(run, cluster, batchA, 0),
        newMembership(run, cluster, batchA, 0),
      ]);
    });
    expect(code).toBe('23505');
  });

  it('refuses completion with missing coverage, an excluded member or wrong counters', async () => {
    // One eligible result has no membership.
    const missing = await expectRejected(isolated.db, async (tx) => {
      const run = newRun(batchA);
      await insertRunningClusteringRun(tx, run);
      const cluster = newCluster(run, hash('6').slice(0, 32), 1, batchA.rowIds[0] ?? '');
      await insertIncidentClusters(tx, [cluster]);
      await insertIncidentMemberships(tx, [newMembership(run, cluster, batchA, 0)]);
      await completeClusteringRun(
        tx,
        run.id,
        {
          eligibleRowCount: 2,
          ineligibleRowCount: 1,
          duplicateGroupCount: 1,
          syndicationGroupCount: 1,
          incidentCount: 1,
          singletonIncidentCount: 1,
          multiSourceIncidentCount: 0,
          largestClusterSize: 1,
          ambiguousLinkCount: 0,
        },
        new Date().toISOString(),
      );
    });
    expect(missing).toBe('P0001');

    // A membership for the excluded result.
    const excluded = await expectRejected(isolated.db, async (tx) => {
      const run = newRun(batchA);
      await insertRunningClusteringRun(tx, run);
      const cluster = newCluster(run, hash('7').slice(0, 32), 3, batchA.rowIds[0] ?? '');
      await insertIncidentClusters(tx, [cluster]);
      await insertIncidentMemberships(tx, [
        newMembership(run, cluster, batchA, 0),
        newMembership(run, cluster, batchA, 1),
        newMembership(run, cluster, batchA, 2, { decision: 'include' }),
      ]);
      await completeClusteringRun(
        tx,
        run.id,
        await deriveClusteringCounts(tx, run.id, batchA.classificationRunId, ['include', 'review']),
        new Date().toISOString(),
      );
    });
    expect(excluded).toBe('P0001');

    // Correct output, counters that describe something else.
    const wrongCounters = await expectRejected(isolated.db, async (tx) => {
      const run = newRun(batchA);
      await insertRunningClusteringRun(tx, run);
      const first = newCluster(run, hash('8').slice(0, 32), 1, batchA.rowIds[0] ?? '');
      const second = newCluster(run, hash('9').slice(0, 32), 1, batchA.rowIds[1] ?? '');
      await insertIncidentClusters(tx, [first, second]);
      await insertIncidentMemberships(tx, [
        newMembership(run, first, batchA, 0),
        newMembership(run, second, batchA, 1),
      ]);
      await completeClusteringRun(
        tx,
        run.id,
        {
          eligibleRowCount: 2,
          ineligibleRowCount: 1,
          duplicateGroupCount: 2,
          syndicationGroupCount: 2,
          incidentCount: 1,
          singletonIncidentCount: 1,
          multiSourceIncidentCount: 0,
          largestClusterSize: 1,
          ambiguousLinkCount: 0,
        },
        new Date().toISOString(),
      );
    });
    expect(wrongCounters).toBe('P0001');
  });

  it('refuses a duplicate idempotency key and a duplicate fingerprint in one run', async () => {
    const first = await completeRun(batchB);
    const duplicateKey = await expectRejected(isolated.db, (tx) =>
      insertRunningClusteringRun(tx, newRun(batchB, { idempotencyKey: first.idempotencyKey })),
    );
    expect(duplicateKey).toBe('23505');

    const run = newRun(batchA);
    const duplicateFingerprint = await expectRejected(isolated.db, async (tx) => {
      await insertRunningClusteringRun(tx, run);
      await insertIncidentClusters(tx, [
        newCluster(run, hash('a').slice(0, 32), 1, batchA.rowIds[0] ?? ''),
        newCluster(run, hash('a').slice(0, 32), 1, batchA.rowIds[1] ?? ''),
      ]);
    });
    expect(duplicateFingerprint).toBe('23505');
  });

  it('refuses a review action against a run that is not completed', async () => {
    const run = newRun(batchA);
    const code = await expectRejected(isolated.db, async (tx) => {
      await insertRunningClusteringRun(tx, run);
      await tx.query(
        `INSERT INTO clustering_review_actions (
           id, clustering_run_id, batch_id, operation, reason_code, note, actor, prior_revision,
           resulting_revision, idempotency_key, affected_incident_ids, affected_membership_ids,
           created_at
         ) VALUES ($1, $2, $3, 'merge', 'same_incident', NULL, 'owner', 0, 1, $4,
                   '["a","b"]'::jsonb, '[]'::jsonb, now())`,
        [randomUUID(), run.id, run.batchId, key()],
      );
    });
    expect(code).toBe('P0001');
  });

  it('refuses two review actions claiming the same revision', async () => {
    const run = await completeRun(batchA);
    await isolated.db.withClient(async (c) => {
      await c.query(
        `INSERT INTO clustering_review_actions (
           id, clustering_run_id, batch_id, operation, reason_code, note, actor, prior_revision,
           resulting_revision, idempotency_key, affected_incident_ids, affected_membership_ids,
           created_at
         ) VALUES ($1, $2, $3, 'merge', 'same_incident', NULL, 'owner', 0, 1, $4,
                   '["a","b"]'::jsonb, '[]'::jsonb, now())`,
        [randomUUID(), run.id, run.batchId, key()],
      );
    });
    const code = await expectRejected(isolated.db, (tx) =>
      tx.query(
        `INSERT INTO clustering_review_actions (
           id, clustering_run_id, batch_id, operation, reason_code, note, actor, prior_revision,
           resulting_revision, idempotency_key, affected_incident_ids, affected_membership_ids,
           created_at
         ) VALUES ($1, $2, $3, 'merge', 'other_reason', NULL, 'owner', 0, 1, $4,
                   '["c","d"]'::jsonb, '[]'::jsonb, now())`,
        [randomUUID(), run.id, run.batchId, key()],
      ),
    );
    expect(code).toBe('23505');
  });

  it('refuses a malformed review action shape', async () => {
    const run = await completeRun(batchB);
    // A merge naming one incident is not a merge.
    const code = await expectRejected(isolated.db, (tx) =>
      tx.query(
        `INSERT INTO clustering_review_actions (
           id, clustering_run_id, batch_id, operation, reason_code, note, actor, prior_revision,
           resulting_revision, idempotency_key, affected_incident_ids, affected_membership_ids,
           created_at
         ) VALUES ($1, $2, $3, 'merge', 'same_incident', NULL, 'owner', 0, 1, $4,
                   '["only-one"]'::jsonb, '[]'::jsonb, now())`,
        [randomUUID(), run.id, run.batchId, key()],
      ),
    );
    expect(code).toBe('23514');
  });
});
