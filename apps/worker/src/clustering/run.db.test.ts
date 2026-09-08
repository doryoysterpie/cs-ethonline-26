import { randomUUID } from 'node:crypto';

import { CLUSTERING_CONTRACT, contractHash, ENGINE_VERSION } from '@cas/clustering';
import type { ReviewState } from '@cas/contracts';
import {
  countReviewState,
  getClusteringRun,
  isDatabaseError,
  listReviewActions,
  type Database,
} from '@cas/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { classifyBatch } from '../classification/run.js';
import { openMigratedSchema, type IsolatedSchema } from '../test-support.js';
import { reportClusteringRun } from './report.js';
import {
  effectiveIncidents,
  mergeIncidents,
  reviewCounts,
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
