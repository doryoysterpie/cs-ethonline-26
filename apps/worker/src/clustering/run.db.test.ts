import { randomUUID } from 'node:crypto';

import {
  CLUSTERING_CONTRACT,
  contractHash,
  CONTRACT_VERSION,
  ENGINE_VERSION,
} from '@cas/clustering';
import type { ReviewState } from '@cas/contracts';
import {
  countReviewState,
  getClusteringRun,
  insertIncidentClusters,
  insertRunningClusteringRun,
  isDatabaseError,
  listReviewActions,
  migrationStatus,
  runMigrations,
  type Database,
} from '@cas/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { classifyBatch } from '../classification/run.js';
import { EXIT_CODES, isIngestionError } from '../editorial/errors.js';
import { openMigratedSchema, openSchemaMigratedTo, type IsolatedSchema } from '../test-support.js';
import { reportClusteringRun } from './report.js';
import {
  effectiveIncidents,
  mergeIncidents,
  payloadOfAction,
  reviewCounts,
  reviewPayloadDigest,
  splitIncident,
  type EffectiveView,
} from './review.js';
import { clusterClassificationRun, computeClusteringIdempotencyKey } from './run.js';

/**
 * Clustering against a migrated schema: a real classification run in, base
 * clusters and memberships out, then the human layer over the top.
 *
 * Every fixture is synthetic. The organisations, places and wording are
 * invented for the test.
 */

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

interface Seeded {
  readonly batchId: string;
  readonly rowIds: readonly string[];
}

/**
 * Rows chosen so the corpus exercises all three stages: boilerplate
 * background, an exact duplicate pair, a syndicated pair, a same-incident
 * pair, and one row the classifier excludes.
 */
const ROWS: readonly {
  title: string;
  summary: string | null;
  urlGroup: string;
  quarantined?: boolean;
}[] = [
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
    title: 'Kestrelvale Water district confirms a ransomware breach of billing systems',
    summary: 'Kestrelvale Water said billing was offline for two days after the ransomware breach.',
    urlGroup: 'syn-b',
  },
  {
    title: 'Eastvale Hospital pharmacy notice about a malware incident',
    summary: 'Eastvale Hospital pharmacy in Bridgeport described a malware incident on Tuesday.',
    urlGroup: 'dup',
  },
  {
    title: 'Eastvale Hospital pharmacy notice about a malware incident',
    summary: 'Eastvale Hospital pharmacy in Bridgeport described a malware incident on Tuesday.',
    urlGroup: 'dup',
  },
  {
    title: 'A slow-cooker recipe for the weekend',
    summary: 'Serve the casserole with a salad and a grand slam final on the television.',
    urlGroup: 'exc',
  },
];

async function seedBatch(
  db: Database,
  label: string,
  labelFor: (index: number) => ReviewState = () => 'selected',
): Promise<Seeded> {
  const batchId = randomUUID();
  const snapshotId = randomUUID();
  const rowIds = ROWS.map(() => randomUUID());
  const groups = new Map<string, string>();
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO import_batches (
         id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
         header_cells, importer_version, idempotency_key, status, parsed_row_count,
         accepted_row_count, quarantined_row_count, started_at, completed_at
       ) VALUES ($1, 'replay', 'weekly', $2, 'seed.csv', $3, 10, '["ch"]'::jsonb,
                 'editorial-csv-import@1', $4, 'completed', $5, $5, 0, now(), now())`,
      [
        batchId,
        label,
        hash('a'),
        randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
        ROWS.length,
      ],
    );
    await tx.query(
      `INSERT INTO review_snapshots (id, batch_id, review_label, data_origin, created_at)
       VALUES ($1, $2, $3, 'replay', now())`,
      [snapshotId, batchId, label],
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
      await tx.query(
        `INSERT INTO source_rows (
           id, batch_id, row_number, data_origin, status, raw_cells, raw_fields, raw_ch,
           raw_url, raw_category, posted_at, normalized_title, derived_summary_text,
           text_transform, canonical_url, url_group_id, row_hash
         ) VALUES ($1, $2, $3, 'replay', 'accepted', '["TRUE"]'::jsonb, '{"ch":"TRUE"}'::jsonb,
                   'TRUE', $4, 'Security', $5::timestamptz, $6, $7, 'html-to-text@1', $4, $8, $9)`,
        [
          rowIds[index],
          batchId,
          index + 1,
          `https://seed.example/${label}/${spec.urlGroup}`,
          `2026-06-0${(index % 3) + 1}T00:00:00.000Z`,
          spec.title,
          spec.summary,
          groupId,
          hash(String(index % 10)),
        ],
      );
      await tx.query(
        `INSERT INTO review_entries (id, snapshot_id, source_row_id, batch_id, raw_value, review_state)
         VALUES ($1, $2, $3, $4, 'TRUE', $5)`,
        [randomUUID(), snapshotId, rowIds[index], batchId, labelFor(index)],
      );
    }
  });
  return { batchId, rowIds };
}

describe('clustering against a migrated schema', () => {
  let isolated: IsolatedSchema;
  let classificationRunId = '';

  beforeAll(async () => {
    isolated = await openMigratedSchema();
    const seeded = await seedBatch(isolated.db, 'CS01');
    const classified = await classifyBatch(isolated.db, { batchId: seeded.batchId });
    classificationRunId = classified.run.id;
  });

  afterAll(async () => {
    await isolated.close();
  });

  async function baseRun(): Promise<string> {
    const outcome = await clusterClassificationRun(isolated.db, { classificationRunId });
    return outcome.run.id;
  }

  it('covers every eligible result exactly once and no excluded result at all', async () => {
    const outcome = await clusterClassificationRun(isolated.db, { classificationRunId });
    expect(outcome.outcome).toBe('clustered');
    expect(outcome.run.status).toBe('completed');
    expect(outcome.run.engineVersion).toBe(ENGINE_VERSION);
    expect(outcome.run.contractHash).toBe(contractHash());

    const counts = await isolated.db.withClient((c) =>
      c.query<{
        eligible: string;
        memberships: string;
        excluded_linked: string;
        uncovered: string;
        duplicated: string;
      }>(
        `SELECT (SELECT count(*) FROM classification_results
                  WHERE run_id = $2 AND decision IN ('include','review'))::text AS eligible,
                (SELECT count(*) FROM incident_memberships WHERE clustering_run_id = $1)::text
                  AS memberships,
                (SELECT count(*) FROM incident_memberships m
                   JOIN classification_results r ON r.id = m.classification_result_id
                  WHERE m.clustering_run_id = $1 AND r.decision = 'exclude')::text
                  AS excluded_linked,
                (SELECT count(*) FROM classification_results r
                  WHERE r.run_id = $2 AND r.decision IN ('include','review')
                    AND NOT EXISTS (SELECT 1 FROM incident_memberships m
                                     WHERE m.clustering_run_id = $1
                                       AND m.source_row_id = r.source_row_id))::text AS uncovered,
                (SELECT count(*) FROM (SELECT source_row_id FROM incident_memberships
                                        WHERE clustering_run_id = $1
                                        GROUP BY source_row_id HAVING count(*) > 1) d)::text
                  AS duplicated`,
        [outcome.run.id, classificationRunId],
      ),
    );
    const row = counts.rows[0];
    expect(row?.memberships).toBe(row?.eligible);
    expect(row?.excluded_linked).toBe('0');
    expect(row?.uncovered).toBe('0');
    expect(row?.duplicated).toBe('0');
    expect(outcome.run.eligibleRowCount).toBe(Number(row?.eligible));
    expect(outcome.run.ineligibleRowCount).toBeGreaterThan(0);

    const report = await reportClusteringRun(isolated.db, outcome.run.id);
    expect(report.reconciled).toBe(true);
  });

  it('finds the exact duplicate, the syndicated pair and the shared incident', async () => {
    const runId = await baseRun();
    const kinds = await isolated.db.withClient((c) =>
      c.query<{ kind: string; count: string }>(
        `SELECT kind, count(*)::text AS count FROM incident_clusters
          WHERE clustering_run_id = $1 GROUP BY kind ORDER BY kind`,
        [runId],
      ),
    );
    const byKind = new Map(kinds.rows.map((row) => [row.kind, Number(row.count)]));
    expect(byKind.get('duplicate_group') ?? 0).toBeGreaterThan(0);
    expect(byKind.get('syndicated_group') ?? 0).toBeGreaterThan(0);
    expect(byKind.get('multi_report_incident') ?? 0).toBeGreaterThan(0);
    // Every membership keeps its duplicate and syndication identity.
    const fingerprints = await isolated.db.withClient((c) =>
      c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM incident_memberships
          WHERE clustering_run_id = $1
            AND (duplicate_fingerprint = '' OR syndication_fingerprint = '')`,
        [runId],
      ),
    );
    expect(fingerprints.rows[0]?.count).toBe('0');
  });

  it('is idempotent, and a changed contract would be a distinct run', async () => {
    const first = await clusterClassificationRun(isolated.db, { classificationRunId });
    const before = await isolated.db.withClient((c) =>
      c.query<{ runs: string; members: string }>(
        `SELECT (SELECT count(*) FROM clustering_runs)::text AS runs,
                (SELECT count(*) FROM incident_memberships)::text AS members`,
      ),
    );
    const second = await clusterClassificationRun(isolated.db, { classificationRunId });
    expect(second.outcome).toBe('already_clustered');
    expect(second.run.id).toBe(first.run.id);
    const after = await isolated.db.withClient((c) =>
      c.query<{ runs: string; members: string }>(
        `SELECT (SELECT count(*) FROM clustering_runs)::text AS runs,
                (SELECT count(*) FROM incident_memberships)::text AS members`,
      ),
    );
    expect(after.rows[0]).toEqual(before.rows[0]);

    const current = computeClusteringIdempotencyKey({
      classificationRunId,
      engineVersion: ENGINE_VERSION,
      contractVersion: CLUSTERING_CONTRACT.contractVersion,
      contractHash: contractHash(),
    });
    const changed = computeClusteringIdempotencyKey({
      classificationRunId,
      engineVersion: ENGINE_VERSION,
      contractVersion: CLUSTERING_CONTRACT.contractVersion,
      contractHash: hash('e'),
    });
    const changedEngine = computeClusteringIdempotencyKey({
      classificationRunId,
      engineVersion: 'clustering-engine@99',
      contractVersion: CLUSTERING_CONTRACT.contractVersion,
      contractHash: contractHash(),
    });
    expect(new Set([current, changed, changedEngine]).size).toBe(3);
  });

  it('lets exactly one of two identical concurrent runs create the output', async () => {
    const other = await seedBatch(isolated.db, 'CS02');
    const classified = await classifyBatch(isolated.db, { batchId: other.batchId });
    const [a, b] = await Promise.all([
      clusterClassificationRun(isolated.db, { classificationRunId: classified.run.id }),
      clusterClassificationRun(isolated.db, { classificationRunId: classified.run.id }),
    ]);
    expect(a.run.id).toBe(b.run.id);
    expect([a.outcome, b.outcome].sort()).toEqual(['already_clustered', 'clustered']);
    const rows = await isolated.db.withClient((c) =>
      c.query<{ runs: string }>(
        `SELECT count(*)::text AS runs FROM clustering_runs WHERE classification_run_id = $1`,
        [classified.run.id],
      ),
    );
    expect(rows.rows[0]?.runs).toBe('1');
  });

  it('refuses a classification run that is missing or not completed', async () => {
    await expect(
      clusterClassificationRun(isolated.db, { classificationRunId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'classification_run_not_found' });
  });

  it('leaves a completed run, its clusters and its memberships immutable', async () => {
    const runId = await baseRun();
    const attempts: [name: string, sql: string][] = [
      [
        'run status',
        `UPDATE clustering_runs SET status = 'running', completed_at = NULL WHERE id = $1`,
      ],
      ['run counters', 'UPDATE clustering_runs SET incident_count = 0 WHERE id = $1'],
      ['run delete', 'DELETE FROM clustering_runs WHERE id = $1'],
      [
        'cluster kind',
        `UPDATE incident_clusters SET kind = 'singleton' WHERE clustering_run_id = $1`,
      ],
      ['cluster delete', 'DELETE FROM incident_clusters WHERE clustering_run_id = $1'],
      [
        'membership move',
        `UPDATE incident_memberships SET decision = 'review' WHERE clustering_run_id = $1`,
      ],
      ['membership delete', 'DELETE FROM incident_memberships WHERE clustering_run_id = $1'],
    ];
    const links = await isolated.db.withClient((c) =>
      c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM clustering_ambiguous_links WHERE clustering_run_id = $1`,
        [runId],
      ),
    );
    if (links.rows[0]?.count !== '0') {
      attempts.push([
        'link delete',
        'DELETE FROM clustering_ambiguous_links WHERE clustering_run_id = $1',
      ]);
    }
    for (const [name, sql] of attempts) {
      let caught: unknown;
      try {
        await isolated.db.withTransaction(async (tx) => {
          await tx.query(sql, [runId]);
        });
      } catch (error) {
        caught = error;
      }
      expect(isDatabaseError(caught), name).toBe(true);
      expect(isDatabaseError(caught) ? caught.code : '', name).toBe('P0001');
    }
    const still = await isolated.db.withClient((c) => getClusteringRun(c, runId));
    expect(still?.status).toBe('completed');
  });

  it('never touches the human review tables from earlier sprints', async () => {
    const before = await isolated.db.withClient(countReviewState);
    await baseRun();
    expect(await isolated.db.withClient(countReviewState)).toEqual(before);
  });
});

describe('the human merge and split layer', () => {
  let isolated: IsolatedSchema;
  let runId = '';
  let otherRunId = '';

  beforeAll(async () => {
    isolated = await openMigratedSchema();
    const seeded = await seedBatch(isolated.db, 'CS10');
    const classified = await classifyBatch(isolated.db, { batchId: seeded.batchId });
    runId = (
      await clusterClassificationRun(isolated.db, { classificationRunId: classified.run.id })
    ).run.id;
    const second = await seedBatch(isolated.db, 'CS11');
    const classifiedSecond = await classifyBatch(isolated.db, { batchId: second.batchId });
    otherRunId = (
      await clusterClassificationRun(isolated.db, {
        classificationRunId: classifiedSecond.run.id,
      })
    ).run.id;
  });

  afterAll(async () => {
    await isolated.close();
  });

  const twoIncidents = (view: EffectiveView): [string, string] => {
    const ids = view.incidents.map((incident) => incident.effectiveIncidentId);
    const first = ids[0];
    const second = ids[1];
    if (first === undefined || second === undefined) throw new Error('need two incidents');
    return [first, second];
  };

  it('merges two incidents into one effective incident that keeps every membership', async () => {
    const before = await effectiveIncidents(isolated.db, runId);
    const [left, right] = twoIncidents(before);
    const leftSize =
      before.incidents.find((i) => i.effectiveIncidentId === left)?.membershipIds.length ?? 0;
    const rightSize =
      before.incidents.find((i) => i.effectiveIncidentId === right)?.membershipIds.length ?? 0;

    const merged = await mergeIncidents(isolated.db, {
      runId,
      incidentIds: [left, right],
      reasonCode: 'same_incident',
      actor: 'owner',
    });
    expect(merged.outcome).toBe('recorded');
    expect(merged.revision).toBe(1);

    const after = await effectiveIncidents(isolated.db, runId);
    expect(after.revision).toBe(1);
    expect(after.incidents).toHaveLength(before.incidents.length - 1);
    const combined = after.incidents.find(
      (incident) => incident.effectiveIncidentId === merged.action.id,
    );
    expect(combined?.origin).toBe('merge');
    expect(combined?.membershipIds).toHaveLength(leftSize + rightSize);
    // No membership was lost or duplicated anywhere in the view.
    const total = after.incidents.reduce((sum, incident) => sum + incident.membershipIds.length, 0);
    const baseTotal = before.incidents.reduce(
      (sum, incident) => sum + incident.membershipIds.length,
      0,
    );
    expect(total).toBe(baseTotal);
    expect(new Set(after.incidents.flatMap((i) => i.membershipIds)).size).toBe(total);
  });

  it('replays the same merge idempotently without a second action', async () => {
    const view = await effectiveIncidents(isolated.db, runId);
    const merged = await mergeIncidents(isolated.db, {
      runId,
      incidentIds: twoIncidents(view),
      reasonCode: 'same_incident',
      actor: 'owner',
    });
    const replayed = await mergeIncidents(isolated.db, {
      runId,
      incidentIds: twoIncidents(view),
      reasonCode: 'same_incident',
      actor: 'owner',
    });
    expect(replayed.outcome).toBe('already_recorded');
    expect(replayed.action.id).toBe(merged.action.id);
    expect(replayed.revision).toBe(merged.revision);
    const actions = await isolated.db.withClient((c) => listReviewActions(c, runId));
    expect(actions.filter((action) => action.id === merged.action.id)).toHaveLength(1);
  });

  it('splits selected memberships out without losing or duplicating one', async () => {
    const view = await effectiveIncidents(isolated.db, runId);
    const target = view.incidents.find((incident) => incident.membershipIds.length >= 2);
    if (target === undefined) throw new Error('need a multi-member incident');
    const taken = target.membershipIds.slice(0, 1);

    const split = await splitIncident(isolated.db, {
      runId,
      incidentId: target.effectiveIncidentId,
      membershipIds: taken,
      reasonCode: 'separate_events',
      actor: 'owner',
    });
    expect(split.outcome).toBe('recorded');

    const after = await effectiveIncidents(isolated.db, runId);
    const created = after.incidents.find(
      (incident) => incident.effectiveIncidentId === split.action.id,
    );
    expect(created?.origin).toBe('split');
    expect(created?.membershipIds).toEqual(taken);
    const remainder = after.incidents.find(
      (incident) => incident.effectiveIncidentId === target.effectiveIncidentId,
    );
    expect(remainder?.membershipIds).toHaveLength(target.membershipIds.length - taken.length);
    // Coverage is preserved exactly.
    const before = view.incidents.reduce((sum, i) => sum + i.membershipIds.length, 0);
    const total = after.incidents.reduce((sum, i) => sum + i.membershipIds.length, 0);
    expect(total).toBe(before);
    expect(new Set(after.incidents.flatMap((i) => i.membershipIds)).size).toBe(total);
  });

  it('refuses a stale revision, a cyclic merge, a cross-run action and an over-wide split', async () => {
    const view = await effectiveIncidents(isolated.db, runId);
    const [left] = twoIncidents(view);

    // A merge naming the same incident twice is not a merge.
    await expect(
      mergeIncidents(isolated.db, {
        runId,
        incidentIds: [left, left],
        reasonCode: 'same_incident',
        actor: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'incident_repeated' });

    // An incident of another run is not an incident of this one.
    const otherView = await effectiveIncidents(isolated.db, otherRunId);
    const foreign = otherView.incidents[0]?.effectiveIncidentId ?? '';
    await expect(
      mergeIncidents(isolated.db, {
        runId,
        incidentIds: [left, foreign],
        reasonCode: 'same_incident',
        actor: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'incident_not_effective' });

    // A split may not take every membership.
    const whole = view.incidents.find((incident) => incident.membershipIds.length >= 2);
    if (whole !== undefined) {
      await expect(
        splitIncident(isolated.db, {
          runId,
          incidentId: whole.effectiveIncidentId,
          membershipIds: whole.membershipIds,
          reasonCode: 'separate_events',
          actor: 'owner',
        }),
      ).rejects.toMatchObject({ code: 'split_takes_everything' });
    }

    // Two actions prepared against the same revision: the second is stale.
    const current = await effectiveIncidents(isolated.db, runId);
    const [a, b] = twoIncidents(current);
    const third = current.incidents[2]?.effectiveIncidentId;
    await mergeIncidents(isolated.db, {
      runId,
      incidentIds: [a, b],
      reasonCode: 'same_incident',
      actor: 'owner',
    });
    if (third !== undefined) {
      // `a` no longer exists as an effective incident, so an action built from
      // the stale view is refused rather than applied to the wrong thing.
      await expect(
        mergeIncidents(isolated.db, {
          runId,
          incidentIds: [a, third],
          reasonCode: 'same_incident',
          actor: 'owner',
        }),
      ).rejects.toMatchObject({ code: 'incident_not_effective' });
    }
  });

  it('keeps the review history append-only and the base output untouched', async () => {
    const actions = await isolated.db.withClient((c) => listReviewActions(c, runId));
    expect(actions.length).toBeGreaterThan(0);
    const first = actions[0];
    if (first === undefined) throw new Error('no actions');
    for (const sql of [
      `UPDATE clustering_review_actions SET reason_code = 'other' WHERE id = $1`,
      'DELETE FROM clustering_review_actions WHERE id = $1',
    ]) {
      let caught: unknown;
      try {
        await isolated.db.withTransaction(async (tx) => {
          await tx.query(sql, [first.id]);
        });
      } catch (error) {
        caught = error;
      }
      expect(isDatabaseError(caught) ? caught.code : '').toBe('P0001');
    }
    // Revisions are contiguous and each action names its predecessor.
    const revisions = actions.map((action) => action.resultingRevision);
    expect(revisions).toEqual(actions.map((_, index) => index + 1));
    for (const action of actions) {
      expect(action.resultingRevision).toBe(action.priorRevision + 1);
    }
    // The machine's base output is exactly what it was.
    const base = await isolated.db.withClient((c) =>
      c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM incident_memberships WHERE clustering_run_id = $1`,
        [runId],
      ),
    );
    const run = await isolated.db.withClient((c) => getClusteringRun(c, runId));
    expect(base.rows[0]?.count).toBe(String(run?.eligibleRowCount));
  });

  it('derives the same effective view every time it is asked', async () => {
    const shape = (view: EffectiveView): string =>
      JSON.stringify(
        view.incidents.map((incident) => ({
          id: incident.effectiveIncidentId,
          origin: incident.origin,
          members: incident.membershipIds,
        })),
      );
    const first = shape(await effectiveIncidents(isolated.db, runId));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(shape(await effectiveIncidents(isolated.db, runId))).toBe(first);
    }
    const counts = await reviewCounts(isolated.db, runId);
    expect(counts.effectiveIncidents).toBe(JSON.parse(first).length);
    expect(counts.revision).toBeGreaterThan(0);
  });

  it('refuses a review action against a run that does not exist', async () => {
    await expect(
      mergeIncidents(isolated.db, {
        runId: randomUUID(),
        incidentIds: [randomUUID(), randomUUID()],
        reasonCode: 'same_incident',
        actor: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'clustering_run_not_found' });
  });
});

/**
 * The three invariants migration 0007 moved from belief into the schema
 * (Codex Desktop findings F2, F3 and F4). Every probe here goes to the
 * database directly or through the compiled artifact, because that is where
 * the audit found the gaps: the integration suite was green while a direct
 * insert, a direct API call and a replayed payload all did what they must not.
 */

const char = (code: number): string => String.fromCharCode(code);

const PROHIBITED_NOTE_CHARACTERS: readonly [name: string, value: string][] = [
  ['tab', char(0x09)],
  ['newline', char(0x0a)],
  ['carriage return', char(0x0d)],
  ['escape', char(0x1b)],
  ['delete', char(0x7f)],
  ['C1 control sequence introducer', char(0x9b)],
  ['line separator', char(0x2028)],
  ['paragraph separator', char(0x2029)],
];

const FINGERPRINT = 'abcdef0123456789';

/**
 * A second completed classification run over the same batch and the same
 * source rows: the state Codex Desktop used to bind a clustering run of one
 * run to a result of the other.
 */
async function duplicateClassificationRun(db: Database, sourceRunId: string): Promise<string> {
  const id = randomUUID();
  const key = randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64);
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO classification_runs (
         id, batch_id, data_origin, classifier_version, ruleset_version, ruleset_hash, mode,
         idempotency_key, status, expected_row_count, classified_row_count, include_count,
         exclude_count, review_count, started_at, completed_at)
       SELECT $1, batch_id, data_origin, classifier_version, ruleset_version, ruleset_hash, mode,
              $2, 'running', expected_row_count, 0, 0, 0, 0, started_at, NULL
         FROM classification_runs WHERE id = $3`,
      [id, key, sourceRunId],
    );
    await tx.query(
      `INSERT INTO classification_results (
         id, run_id, batch_id, source_row_id, decision, rationale_codes, matched_signals,
         signal_score, row_hash, created_at)
       SELECT gen_random_uuid(), $1, batch_id, source_row_id, decision, rationale_codes,
              matched_signals, signal_score, row_hash, created_at
         FROM classification_results WHERE run_id = $2`,
      [id, sourceRunId],
    );
    await tx.query(
      `UPDATE classification_runs c
          SET status = 'completed', classified_row_count = s.classified_row_count,
              include_count = s.include_count, exclude_count = s.exclude_count,
              review_count = s.review_count, completed_at = now()
         FROM classification_runs s
        WHERE c.id = $1 AND s.id = $2`,
      [id, sourceRunId],
    );
  });
  return id;
}

interface ResultRow {
  readonly resultId: string;
  readonly sourceRowId: string;
  readonly rowHash: string;
  readonly decision: string;
  readonly batchId: string;
}

async function eligibleResults(db: Database, runId: string): Promise<ResultRow[]> {
  const found = await db.withClient((c) =>
    c.query<{
      id: string;
      source_row_id: string;
      row_hash: string;
      decision: string;
      batch_id: string;
    }>(
      `SELECT id, source_row_id, row_hash, decision, batch_id FROM classification_results
        WHERE run_id = $1 AND decision IN ('include','review')
        ORDER BY source_row_id`,
      [runId],
    ),
  );
  if (found.rows.length === 0) throw new Error('no eligible classification result');
  return found.rows.map((row) => ({
    resultId: row.id,
    sourceRowId: row.source_row_id,
    rowHash: row.row_hash,
    decision: row.decision,
    batchId: row.batch_id,
  }));
}

async function resultForRow(db: Database, runId: string, sourceRowId: string): Promise<string> {
  const found = await db.withClient((c) =>
    c.query<{ id: string }>(
      `SELECT id FROM classification_results WHERE run_id = $1 AND source_row_id = $2`,
      [runId, sourceRowId],
    ),
  );
  const id = found.rows[0]?.id;
  if (id === undefined) throw new Error('no classification result for that row');
  return id;
}

describe('migration 0007 binds every membership to its run’s classification run', () => {
  let isolated: IsolatedSchema;
  let classificationA = '';
  let classificationB = '';
  let classificationOtherBatch = '';
  let batchA = '';
  let clusteringRunId = '';
  let otherClusteringRunId = '';
  let clusterId = '';
  let otherClusterId = '';
  let sampleA: ResultRow;
  let sampleOtherBatch: ResultRow;
  let pool: ResultRow[] = [];
  /** Two rows reserved for the probes that must name run B's result for them. */
  let crossRun: ResultRow;
  let crossRunResultInB = '';
  let wrongResult: ResultRow;
  let wrongResultInB = '';

  /**
   * A source row no earlier probe has used. `incident_memberships` is unique
   * per (clustering run, source row), so reusing one would raise that
   * uniqueness before the constraint under test could be reached.
   */
  const nextResult = (): ResultRow => {
    const row = pool.shift();
    if (row === undefined) throw new Error('the fixture ran out of eligible results');
    return row;
  };

  beforeAll(async () => {
    isolated = await openMigratedSchema();
    const seeded = await seedBatch(isolated.db, 'CS30');
    batchA = seeded.batchId;
    classificationA = (await classifyBatch(isolated.db, { batchId: batchA })).run.id;
    classificationB = await duplicateClassificationRun(isolated.db, classificationA);
    const other = await seedBatch(isolated.db, 'CS31');
    classificationOtherBatch = (await classifyBatch(isolated.db, { batchId: other.batchId })).run
      .id;
    pool = await eligibleResults(isolated.db, classificationA);
    sampleA = pool[0] as ResultRow;
    sampleOtherBatch = (
      await eligibleResults(isolated.db, classificationOtherBatch)
    )[0] as ResultRow;
    crossRun = nextResult();
    crossRunResultInB = await resultForRow(isolated.db, classificationB, crossRun.sourceRowId);
    wrongResult = nextResult();
    wrongResultInB = await resultForRow(isolated.db, classificationB, wrongResult.sourceRowId);

    // Two clustering runs left in the running state, so the output guard
    // permits writes and each probe faces the referential constraints alone.
    const open = async (
      classificationRunId: string,
      batchId: string,
    ): Promise<[string, string]> => {
      const runId = randomUUID();
      const cluster = randomUUID();
      await isolated.db.withTransaction(async (tx) => {
        await insertRunningClusteringRun(tx, {
          id: runId,
          classificationRunId,
          batchId,
          dataOrigin: 'replay',
          engineVersion: ENGINE_VERSION,
          contractVersion: CONTRACT_VERSION,
          contractHash: contractHash(),
          idempotencyKey: randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
          startedAt: new Date().toISOString(),
        });
        await insertIncidentClusters(tx, [
          {
            id: cluster,
            clusteringRunId: runId,
            batchId,
            fingerprint: FINGERPRINT,
            kind: 'singleton',
            memberCount: 1,
            duplicateGroupCount: 1,
            syndicationGroupCount: 1,
            reasonCodes: ['singleton_source'],
            representativeSourceRowId: sampleA.sourceRowId,
            createdAt: new Date().toISOString(),
          },
        ]);
      });
      return [runId, cluster];
    };
    [clusteringRunId, clusterId] = await open(classificationA, batchA);
    [otherClusteringRunId, otherClusterId] = await open(classificationB, batchA);
  });

  afterAll(async () => {
    await isolated.close();
  });

  /** One membership insert, every field explicit so a probe can spoil exactly one. */
  async function insertMembership(
    overrides: Partial<Record<string, string>> = {},
    base: ResultRow = nextResult(),
  ): Promise<void> {
    const values = {
      id: randomUUID(),
      clustering_run_id: clusteringRunId,
      incident_cluster_id: clusterId,
      batch_id: batchA,
      source_row_id: base.sourceRowId,
      row_hash: base.rowHash,
      classification_result_id: base.resultId,
      classification_run_id: classificationA,
      decision: base.decision,
      ...overrides,
    };
    await isolated.db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO incident_memberships (
           id, clustering_run_id, incident_cluster_id, batch_id, data_origin, source_row_id,
           row_hash, classification_result_id, classification_run_id, decision,
           duplicate_fingerprint, syndication_fingerprint, created_at
         ) VALUES ($1, $2, $3, $4, 'replay', $5, $6, $7, $8, $9, $10, $10, now())`,
        [
          values.id,
          values.clustering_run_id,
          values.incident_cluster_id,
          values.batch_id,
          values.source_row_id,
          values.row_hash,
          values.classification_result_id,
          values.classification_run_id,
          values.decision,
          FINGERPRINT,
        ],
      );
    });
  }

  it('accepts a membership whose whole provenance chain agrees', async () => {
    await expect(insertMembership()).resolves.toBeUndefined();
  });

  it('refuses a result of a different classification run in the same batch', async () => {
    // The exact state the audit reproduced: one batch, one source row, two
    // completed classification runs, and a clustering run of the first
    // accepting a membership that names the second.
    await expect(
      insertMembership(
        { classification_run_id: classificationB, classification_result_id: crossRunResultInB },
        crossRun,
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses the right classification run with the wrong result', async () => {
    await expect(
      insertMembership({ classification_result_id: wrongResultInB }, wrongResult),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses a result from another batch', async () => {
    await expect(
      insertMembership({
        classification_result_id: sampleOtherBatch.resultId,
        source_row_id: sampleOtherBatch.sourceRowId,
        classification_run_id: classificationOtherBatch,
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses a cluster belonging to another clustering run', async () => {
    await expect(insertMembership({ incident_cluster_id: otherClusterId })).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('refuses a membership whose clustering run declares a different classification run', async () => {
    // The new composite key in isolation: the cluster belongs to the named
    // clustering run and the batch agrees, so the only disagreement left is
    // the pairing the audit found unenforced. Run B declares classification
    // run B; this membership names run B while claiming classification run A.
    await expect(
      insertMembership({
        clustering_run_id: otherClusteringRunId,
        incident_cluster_id: otherClusterId,
        classification_run_id: classificationA,
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses a source row hash that is not the stored one', async () => {
    await expect(insertMembership({ row_hash: hash('f') })).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('refuses the same substitution through an update, not only an insert', async () => {
    const id = randomUUID();
    const base = nextResult();
    await insertMembership({ id }, base);
    const substitute = await resultForRow(isolated.db, classificationB, base.sourceRowId);
    let caught: unknown;
    try {
      await isolated.db.withTransaction(async (tx) => {
        await tx.query(
          `UPDATE incident_memberships
              SET classification_run_id = $2, classification_result_id = $3 WHERE id = $1`,
          [id, classificationB, substitute],
        );
      });
    } catch (error) {
      caught = error;
    }
    expect(isDatabaseError(caught) ? caught.code : '').toBe('23503');
    // The row is exactly what it was.
    const after = await isolated.db.withClient((c) =>
      c.query<{ classification_run_id: string }>(
        'SELECT classification_run_id FROM incident_memberships WHERE id = $1',
        [id],
      ),
    );
    expect(after.rows[0]?.classification_run_id).toBe(classificationA);
  });

  it('completes a real run and reconciles with no membership from another run', async () => {
    const outcome = await clusterClassificationRun(isolated.db, {
      classificationRunId: classificationOtherBatch,
    });
    expect(outcome.run.status).toBe('completed');
    const disagreeing = await isolated.db.withClient((c) =>
      c.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM incident_memberships m
           JOIN clustering_runs r ON r.id = m.clustering_run_id
          WHERE m.classification_run_id <> r.classification_run_id`,
      ),
    );
    expect(disagreeing.rows[0]?.count).toBe('0');
  });

  it('refuses a note carrying any prohibited character, inserted directly', async () => {
    // A review action needs a completed run; this one has it.
    const completed = await clusterClassificationRun(isolated.db, {
      classificationRunId: classificationA,
    });
    for (const [name, value] of PROHIBITED_NOTE_CHARACTERS) {
      let caught: unknown;
      try {
        await isolated.db.withTransaction(async (tx) => {
          await tx.query(
            `INSERT INTO clustering_review_actions (
               id, clustering_run_id, batch_id, operation, reason_code, note, actor,
               prior_revision, resulting_revision, idempotency_key, affected_incident_ids,
               affected_membership_ids, created_at
             ) VALUES ($1, $2, $3, 'merge', 'same_incident', $4, 'owner', 0, 1, $5,
                       $6::jsonb, '[]'::jsonb, now())`,
            [
              randomUUID(),
              completed.run.id,
              batchA,
              `checked${value}advisory`,
              randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
              JSON.stringify([randomUUID(), randomUUID()]),
            ],
          );
        });
      } catch (error) {
        caught = error;
      }
      expect(isDatabaseError(caught) ? caught.code : '', name).toBe('23514');
    }
    // An over-long note and an empty one are refused by the same constraint.
    for (const note of ['', 'a'.repeat(281)]) {
      let caught: unknown;
      try {
        await isolated.db.withTransaction(async (tx) => {
          await tx.query(
            `INSERT INTO clustering_review_actions (
               id, clustering_run_id, batch_id, operation, reason_code, note, actor,
               prior_revision, resulting_revision, idempotency_key, affected_incident_ids,
               affected_membership_ids, created_at
             ) VALUES ($1, $2, $3, 'merge', 'same_incident', $4, 'owner', 0, 1, $5,
                       $6::jsonb, '[]'::jsonb, now())`,
            [
              randomUUID(),
              completed.run.id,
              batchA,
              note,
              randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
              JSON.stringify([randomUUID(), randomUUID()]),
            ],
          );
        });
      } catch (error) {
        caught = error;
      }
      expect(isDatabaseError(caught) ? caught.code : '').toBe('23514');
    }
  });
});

describe('review idempotency covers the whole payload', () => {
  let isolated: IsolatedSchema;
  let runId = '';
  let left = '';
  let right = '';

  beforeAll(async () => {
    isolated = await openMigratedSchema();
    const seeded = await seedBatch(isolated.db, 'CS40');
    const classified = await classifyBatch(isolated.db, { batchId: seeded.batchId });
    runId = (
      await clusterClassificationRun(isolated.db, { classificationRunId: classified.run.id })
    ).run.id;
    const view = await effectiveIncidents(isolated.db, runId);
    left = view.incidents[0]?.effectiveIncidentId ?? '';
    right = view.incidents[1]?.effectiveIncidentId ?? '';
  });

  afterAll(async () => {
    await isolated.close();
  });

  const countActions = async (): Promise<number> =>
    (await isolated.db.withClient((c) => listReviewActions(c, runId))).length;

  const original = (): Parameters<typeof mergeIncidents>[1] & { incidentIds: string[] } => ({
    runId,
    incidentIds: [left, right],
    reasonCode: 'same_incident',
    actor: 'owner',
    note: 'first note',
    expectedRevision: 0,
  });

  it('records once, replays exactly, and agrees with the digest the database generated', async () => {
    const first = await mergeIncidents(isolated.db, original());
    expect(first.outcome).toBe('recorded');
    const replay = await mergeIncidents(isolated.db, original());
    expect(replay.outcome).toBe('already_recorded');
    expect(replay.action.id).toBe(first.action.id);
    expect(await countActions()).toBe(1);
    expect(first.action.actor).toBe('owner');
    expect(first.action.note).toBe('first note');
    expect(first.action.expectedRevision).toBe(0);
    // The database computed the identity of the row it stored; the worker
    // computes the same string for the same payload.
    const stored = (await isolated.db.withClient((c) => listReviewActions(c, runId)))[0];
    if (stored === undefined) throw new Error('no stored action');
    expect(stored.payloadDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(reviewPayloadDigest(payloadOfAction(stored))).toBe(stored.payloadDigest);
  });

  it('refuses a replay that changed any field the payload carries', async () => {
    const before = await countActions();
    // Fields outside the stored key: the request claims the same identity
    // while describing a different action, which is a conflict.
    const conflicting: readonly [name: string, change: Record<string, unknown>][] = [
      ['actor', { actor: 'auditor' }],
      ['note', { note: 'different note' }],
      ['absent note', { note: null }],
      ['expected revision', { expectedRevision: 1 }],
      ['undeclared expected revision', { expectedRevision: undefined }],
    ];
    for (const [name, change] of conflicting) {
      let caught: unknown;
      try {
        await mergeIncidents(isolated.db, { ...original(), ...change });
      } catch (error) {
        caught = error;
      }
      expect(isIngestionError(caught), name).toBe(true);
      const error = caught as { code: string; message: string };
      expect(error.code, name).toBe('review_action_conflict');
      // The message names the condition and echoes nothing the caller supplied.
      expect(error.message, name).not.toContain('auditor');
      expect(error.message, name).not.toContain('different note');
      expect(error.message, name).not.toContain('owner');
      expect(error.message, name).not.toContain(runId);
      expect(await countActions(), name).toBe(before);
    }

    // Fields inside the stored key: the request is not a replay at all. It is
    // refused on its own terms and still writes nothing, because the incidents
    // it names were consumed by the action that already landed.
    const notReplays: readonly [name: string, change: Record<string, unknown>][] = [
      ['reason', { reasonCode: 'not_same_incident' }],
      ['incident ids', { incidentIds: [left, randomUUID()] }],
      ['run id', { runId: randomUUID() }],
    ];
    for (const [name, change] of notReplays) {
      let caught: unknown;
      try {
        await mergeIncidents(isolated.db, { ...original(), ...change });
      } catch (error) {
        caught = error;
      }
      expect(isIngestionError(caught), name).toBe(true);
      expect((caught as { code: string }).code, name).not.toBe('');
      expect(await countActions(), name).toBe(before);
    }

    // A different operation over the same incident is likewise not a replay.
    await expect(
      splitIncident(isolated.db, {
        runId,
        incidentId: left,
        membershipIds: [randomUUID()],
        reasonCode: 'same_incident',
        actor: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'incident_not_effective' });
    expect(await countActions()).toBe(before);
  });

  it('treats a differently ordered identifier list as the same request', async () => {
    const before = await countActions();
    const reordered = await mergeIncidents(isolated.db, {
      ...original(),
      incidentIds: [right, left],
    });
    expect(reordered.outcome).toBe('already_recorded');
    const upper = await mergeIncidents(isolated.db, {
      ...original(),
      incidentIds: [right.toUpperCase(), left.toUpperCase()],
    });
    expect(upper.outcome).toBe('already_recorded');
    expect(await countActions()).toBe(before);
  });

  it('refuses a declared revision that has moved, without recording anything', async () => {
    const before = await countActions();
    const view = await effectiveIncidents(isolated.db, runId);
    const [a, b] = [view.incidents[0], view.incidents[1]];
    if (a === undefined || b === undefined) throw new Error('need two incidents');
    await expect(
      mergeIncidents(isolated.db, {
        runId,
        incidentIds: [a.effectiveIncidentId, b.effectiveIncidentId],
        reasonCode: 'same_incident',
        actor: 'owner',
        expectedRevision: view.revision + 5,
      }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    expect(await countActions()).toBe(before);
  });

  it('refuses a prohibited note through the merge and split worker APIs', async () => {
    const before = await countActions();
    const view = await effectiveIncidents(isolated.db, runId);
    const target = view.incidents.find((incident) => incident.membershipIds.length >= 2);
    const [a, b] = [view.incidents[0], view.incidents[1]];
    if (a === undefined || b === undefined) throw new Error('need two incidents');
    for (const [name, value] of PROHIBITED_NOTE_CHARACTERS) {
      const note = `checked${value}advisory`;
      await expect(
        mergeIncidents(isolated.db, {
          runId,
          incidentIds: [a.effectiveIncidentId, b.effectiveIncidentId],
          reasonCode: 'same_incident',
          actor: 'owner',
          note,
        }),
        name,
      ).rejects.toMatchObject({ code: 'note_invalid' });
      if (target !== undefined) {
        await expect(
          splitIncident(isolated.db, {
            runId,
            incidentId: target.effectiveIncidentId,
            membershipIds: target.membershipIds.slice(0, 1),
            reasonCode: 'separate_events',
            actor: 'owner',
            note,
          }),
          name,
        ).rejects.toMatchObject({ code: 'note_invalid' });
      }
    }
    // Nothing was written, and the revision did not move.
    expect(await countActions()).toBe(before);
    expect((await effectiveIncidents(isolated.db, runId)).revision).toBe(view.revision);
  });

  it('refuses a prohibited note through the compiled command line too', async () => {
    // The compiled artifact, not the sources: the audit found the shipped CLI
    // validator bypassed by the shipped API, so both are exercised as built.
    // `test:db` builds `@cas/worker` before this file runs. The specifier is
    // computed so the type checker never resolves the build output.
    const compiled = (await import(
      new URL('../../dist/cli.js', import.meta.url).href
    )) as typeof import('../cli.js');
    for (const [name, value] of PROHIBITED_NOTE_CHARACTERS) {
      const err: string[] = [];
      const out: string[] = [];
      const code = await compiled.run(
        [
          'clustering',
          'merge',
          '--run',
          runId,
          '--incidents',
          `${randomUUID()},${randomUUID()}`,
          '--reason',
          'same_incident',
          '--note',
          `checked${value}advisory`,
        ],
        {
          // Never used: the note is refused before a handle is opened.
          env: { DATABASE_URL: 'postgresql://127.0.0.1:5432/cas' },
          io: { log: (l) => out.push(l), error: (l) => err.push(l) },
        },
      );
      expect(code, name).toBe(EXIT_CODES.configuration);
      expect(out, name).toEqual([]);
      expect(err.join('\n'), name).toContain('note_invalid');
    }
  });
});

describe('migration 0007 refuses to apply over data that violates it', () => {
  /**
   * Both cases build a state migration 0007 forbids while only 0006 is
   * applied, then run the full set. Each must fail as one transaction, leave
   * 0007 unrecorded, and leave the schema exactly as 0006 left it.
   */
  async function assertNothingApplied(isolated: IsolatedSchema): Promise<void> {
    const status = await migrationStatus(isolated.db);
    expect(status.applied.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(status.pending).toEqual(['0007_clustering_integrity.sql']);
    expect(status.drift).toEqual([]);
    const artifacts = await isolated.db.withClient((c) =>
      c.query<{ constraints: string; columns: string; functions: string }>(
        // Every subquery is scoped to the schema under test. `pg_constraint`
        // is database-wide, and the project's own schema in the same database
        // carries these names once migration 0007 is applied there.
        `SELECT (SELECT count(*)::text FROM pg_catalog.pg_constraint c
                   JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
                   JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = current_schema()
                    AND c.conname IN ('incident_memberships_run_classification_fk',
                                      'clustering_actions_note_policy',
                                      'clustering_actions_payload_identity')) AS constraints,
                (SELECT count(*)::text FROM information_schema.columns
                  WHERE table_schema = current_schema()
                    AND table_name = 'clustering_review_actions'
                    AND column_name IN ('expected_revision', 'payload_digest')) AS columns,
                (SELECT count(*)::text FROM pg_catalog.pg_proc p
                   JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = current_schema()
                    AND p.proname = 'clustering_review_payload_digest') AS functions`,
      ),
    );
    expect(artifacts.rows[0]).toEqual({ constraints: '0', columns: '0', functions: '0' });
  }

  it('fails on a membership whose classification run is not its clustering run’s', async () => {
    const isolated = await openSchemaMigratedTo(6);
    try {
      const seeded = await seedBatch(isolated.db, 'CS50');
      const classified = await classifyBatch(isolated.db, { batchId: seeded.batchId });
      const other = await duplicateClassificationRun(isolated.db, classified.run.id);
      const results = await eligibleResults(isolated.db, classified.run.id);
      const sample = results[0] as ResultRow;
      const substitute = await resultForRow(isolated.db, other, sample.sourceRowId);
      const runId = randomUUID();
      const clusterId = randomUUID();
      await isolated.db.withTransaction(async (tx) => {
        await insertRunningClusteringRun(tx, {
          id: runId,
          classificationRunId: classified.run.id,
          batchId: seeded.batchId,
          dataOrigin: 'replay',
          engineVersion: ENGINE_VERSION,
          contractVersion: CONTRACT_VERSION,
          contractHash: contractHash(),
          idempotencyKey: randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
          startedAt: new Date().toISOString(),
        });
        await insertIncidentClusters(tx, [
          {
            id: clusterId,
            clusteringRunId: runId,
            batchId: seeded.batchId,
            fingerprint: FINGERPRINT,
            kind: 'singleton',
            memberCount: 1,
            duplicateGroupCount: 1,
            syndicationGroupCount: 1,
            reasonCodes: ['singleton_source'],
            representativeSourceRowId: sample.sourceRowId,
            createdAt: new Date().toISOString(),
          },
        ]);
        // Accepted at 0006; this is the defect the audit reproduced.
        await tx.query(
          `INSERT INTO incident_memberships (
             id, clustering_run_id, incident_cluster_id, batch_id, data_origin, source_row_id,
             row_hash, classification_result_id, classification_run_id, decision,
             duplicate_fingerprint, syndication_fingerprint, created_at
           ) VALUES ($1, $2, $3, $4, 'replay', $5, $6, $7, $8, $9, $10, $10, now())`,
          [
            randomUUID(),
            runId,
            clusterId,
            seeded.batchId,
            sample.sourceRowId,
            sample.rowHash,
            substitute,
            other,
            sample.decision,
            FINGERPRINT,
          ],
        );
      });

      await expect(runMigrations(isolated.db)).rejects.toThrowError();
      await assertNothingApplied(isolated);
    } finally {
      await isolated.close();
    }
  });

  it('fails on a stored review note that the note policy refuses', async () => {
    const isolated = await openSchemaMigratedTo(6);
    try {
      const seeded = await seedBatch(isolated.db, 'CS51');
      const classified = await classifyBatch(isolated.db, { batchId: seeded.batchId });
      const completed = await clusterClassificationRun(isolated.db, {
        classificationRunId: classified.run.id,
      });
      await isolated.db.withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO clustering_review_actions (
             id, clustering_run_id, batch_id, operation, reason_code, note, actor,
             prior_revision, resulting_revision, idempotency_key, affected_incident_ids,
             affected_membership_ids, created_at
           ) VALUES ($1, $2, $3, 'merge', 'same_incident', $4, 'owner', 0, 1, $5,
                     $6::jsonb, '[]'::jsonb, now())`,
          [
            randomUUID(),
            completed.run.id,
            seeded.batchId,
            `line${char(0x0a)}break`,
            randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
            JSON.stringify([randomUUID(), randomUUID()]),
          ],
        );
      });

      await expect(runMigrations(isolated.db)).rejects.toThrowError();
      await assertNothingApplied(isolated);
    } finally {
      await isolated.close();
    }
  });
});
