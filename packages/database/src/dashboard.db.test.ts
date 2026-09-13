import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  countDashboardTotals,
  getIncidentCluster,
  listAssociationDetails,
  listClusteringRuns,
  listEvidenceRuns,
  listGraphSignalRuns,
  listIncidentClusters,
  listIncidentEvidenceStates,
  listIncidentMembers,
  listReviewQueueEntries,
} from './dashboard.js';
import type { Database } from './database.js';
import { isDatabaseError } from './errors.js';
import { runMigrations } from './migrate.js';
import { openIsolatedSchema, type IsolatedSchema } from './test-support.js';

/**
 * The dashboard reads against a migrated schema.
 *
 * Two properties matter more than the shape of the rows. First, a read made
 * without `withText` must return no text at all, because that is how a judge
 * is kept away from source text: the database never sends it. Second, a read
 * scoped by run and incident must return nothing for an incident that belongs
 * to a different run, however valid the identifier is.
 *
 * The seed text is invented and deliberately hostile: it carries an HTML tag,
 * a control character and a right-to-left override, exactly the content the
 * dashboard has to render inertly. No organisation or headline here is real.
 */

const hash = (seed: string): string => seed.repeat(64).slice(0, 64);
const key = (): string => randomUUID().replace(/-/gu, '').padEnd(64, '0').slice(0, 64);

const HOSTILE_TITLE = `<script>alert(1)</script> ${String.fromCodePoint(0x202e)}reversed${String.fromCodePoint(0x1b)}[31m`;

interface Seeded {
  readonly batchId: string;
  readonly classificationRunId: string;
  readonly clusteringRunId: string;
  readonly incidentIds: readonly string[];
  readonly reviewRowId: string;
  readonly signalRunId: string;
  readonly evidenceRunId: string;
}

/** A batch of three rows, classified, clustered into two incidents, with one signal and one evidence run. */
async function seed(db: Database): Promise<Seeded> {
  const batchId = randomUUID();
  const classificationRunId = randomUUID();
  const clusteringRunId = randomUUID();
  const signalRunId = randomUUID();
  const evidenceRunId = randomUUID();
  const rowIds = [randomUUID(), randomUUID(), randomUUID()];
  const resultIds = [randomUUID(), randomUUID(), randomUUID()];
  const decisions = ['include', 'review', 'include'];
  const incidentIds = [randomUUID(), randomUUID()].sort();
  const signalId = randomUUID();
  const titles = [HOSTILE_TITLE, 'A second invented headline', 'A third invented headline'];
  await db.withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO import_batches (
         id, data_origin, source_kind, review_label, source_basename, file_sha256, byte_length,
         header_cells, importer_version, idempotency_key, status, parsed_row_count,
         accepted_row_count, quarantined_row_count, started_at, completed_at
       ) VALUES ($1, 'replay', 'weekly', 'CS90', 'seed.csv', $2, 10, '["ch"]'::jsonb,
                 'editorial-csv-import@1', $3, 'completed', 3, 3, 0, now(), now())`,
      [batchId, hash('a'), key()],
    );
    for (const [index, id] of rowIds.entries()) {
      await tx.query(
        `INSERT INTO source_rows (
           id, batch_id, row_number, data_origin, status, raw_cells, raw_fields, raw_category,
           posted_at, normalized_title, derived_summary_text, text_transform, row_hash
         ) VALUES ($1, $2, $3, 'replay', 'accepted', '["x"]'::jsonb, '{}'::jsonb, 'Security',
                   '2026-09-04T00:11:07Z', $4, $5, 'html-to-text@1', $6)`,
        [id, batchId, index + 1, titles[index], `summary ${index}`, hash(String(index))],
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
       ) VALUES ($1, $2, 'replay', 'rules-classifier@1', 'policy@1', $3, 'rules', $4,
                 'running', 3, 0, 0, 0, 0, now(), NULL)`,
      [classificationRunId, batchId, hash('f'), key()],
    );
    for (const [index, id] of resultIds.entries()) {
      await tx.query(
        `INSERT INTO classification_results (
           id, run_id, batch_id, source_row_id, decision, rationale_codes, matched_signals,
           signal_score, row_hash, created_at
         ) VALUES ($1, $2, $3, $4, $5, '["decisive_signal"]'::jsonb, '[]'::jsonb, 3, $6, now())`,
        [id, classificationRunId, batchId, rowIds[index], decisions[index], hash(String(index))],
      );
    }
    await tx.query(
      `UPDATE classification_runs
          SET status = 'completed', classified_row_count = 3, include_count = 2,
              exclude_count = 0, review_count = 1, completed_at = now()
        WHERE id = $1`,
      [classificationRunId],
    );
    await tx.query(
      `INSERT INTO clustering_runs (
         id, classification_run_id, batch_id, data_origin, engine_version, contract_version,
         contract_hash, idempotency_key, status, eligible_row_count, ineligible_row_count,
         duplicate_group_count, syndication_group_count, incident_count, singleton_incident_count,
         multi_source_incident_count, largest_cluster_size, ambiguous_link_count, started_at,
         completed_at
       ) VALUES ($1, $2, $3, 'replay', 'clustering-engine@1', 'contract@1', $4, $5, 'running',
                 0, 0, 0, 0, 0, 0, 0, 0, 0, now(), NULL)`,
      [clusteringRunId, classificationRunId, batchId, hash('c'), key()],
    );
    // Incident one holds rows 0 and 1; incident two holds row 2.
    const membership: readonly [string, number][] = [
      [incidentIds[0] ?? '', 0],
      [incidentIds[0] ?? '', 1],
      [incidentIds[1] ?? '', 2],
    ];
    for (const [position, incidentId] of incidentIds.entries()) {
      await tx.query(
        `INSERT INTO incident_clusters (
           id, clustering_run_id, batch_id, fingerprint, kind, member_count, duplicate_group_count,
           syndication_group_count, reason_codes, representative_source_row_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 1, 1, '["shared_signals"]'::jsonb, $7, now())`,
        [
          incidentId,
          clusteringRunId,
          batchId,
          hash(String(position + 5)).slice(0, 16),
          position === 0 ? 'multi_report_incident' : 'singleton',
          position === 0 ? 2 : 1,
          rowIds[position === 0 ? 0 : 2],
        ],
      );
    }
    for (const [incidentId, index] of membership) {
      await tx.query(
        `INSERT INTO incident_memberships (
           id, clustering_run_id, incident_cluster_id, batch_id, data_origin, source_row_id,
           row_hash, classification_result_id, classification_run_id, decision,
           duplicate_fingerprint, syndication_fingerprint, created_at
         ) VALUES ($1, $2, $3, $4, 'replay', $5, $6, $7, $8, $9, $10, $10, now())`,
        [
          randomUUID(),
          clusteringRunId,
          incidentId,
          batchId,
          rowIds[index],
          hash(String(index)),
          resultIds[index],
          classificationRunId,
          decisions[index],
          hash(String(index + 7)).slice(0, 16),
        ],
      );
    }
    await tx.query(
      `UPDATE clustering_runs
          SET status = 'completed', eligible_row_count = 3, ineligible_row_count = 0,
              duplicate_group_count = 2, syndication_group_count = 2, incident_count = 2,
              singleton_incident_count = 1, multi_source_incident_count = 1,
              largest_cluster_size = 2, ambiguous_link_count = 0, completed_at = now()
        WHERE id = $1`,
      [clusteringRunId],
    );
    await tx.query(
      `INSERT INTO incident_subjects (
         id, clustering_run_id, batch_id, incident_cluster_id, chain, protocol_slug, actor,
         reason_code, created_at
       ) VALUES ($1, $2, $3, $4, 'ethereum', 'aave-v3', 'seed', 'seed_subject', now())`,
      [randomUUID(), clusteringRunId, batchId, incidentIds[0]],
    );
    await tx.query(
      `INSERT INTO graph_signal_runs (
         id, data_origin, signal_version, contract_version, contract_hash, query_sha256,
         gateway_host, idempotency_key, status, target_count, signal_count, failed_target_count,
         started_at, completed_at
       ) VALUES ($1, 'replay', 'signal@1', 'contract@1', $2, $3, 'gateway.example', $4,
                 'running', 1, 0, 0, now(), NULL)`,
      [signalRunId, hash('e'), hash('b'), key()],
    );
    await tx.query(
      `INSERT INTO graph_signals (
         id, signal_run_id, data_origin, chain, protocol_slug, subgraph_deployment_id,
         block_number, block_hash, observed_at, baseline_observed_at, elapsed_seconds,
         current_tvl_usd, baseline_tvl_usd, delta_usd, delta_percent, response_digest, created_at
       ) VALUES ($1, $2, 'replay', 'ethereum', 'aave-v3', NULL, 1, NULL, '2026-09-04T01:00:00Z',
                 '2026-09-03T01:00:00Z', 86400, 90, 100, -10, -10, $3, now())`,
      [signalId, signalRunId, hash('d')],
    );
    await tx.query(
      `UPDATE graph_signal_runs SET status = 'completed', signal_count = 1, completed_at = now()
        WHERE id = $1`,
      [signalRunId],
    );
    await tx.query(
      `INSERT INTO evidence_runs (
         id, clustering_run_id, batch_id, signal_run_id, data_origin, resolver_version,
         contract_version, contract_hash, idempotency_key, status, incident_count, signal_count,
         suggestion_count, reported_only_count, onchain_observed_count, corroborated_count,
         contradicted_count, started_at, completed_at
       ) VALUES ($1, $2, $3, $4, 'replay', 'resolver@1', 'contract@1', $5, $6, 'running',
                 0, 0, 0, 0, 0, 0, 0, now(), NULL)`,
      [evidenceRunId, clusteringRunId, batchId, signalRunId, hash('e'), key()],
    );
    await tx.query(
      `INSERT INTO incident_signal_associations (
         id, evidence_run_id, clustering_run_id, batch_id, signal_run_id, incident_cluster_id,
         signal_id, chain, claim_id, relation, status, reason_codes, offset_seconds, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ethereum', NULL, 'context', 'suggested',
                 '["subject_match"]'::jsonb, 3600, now())`,
      [
        randomUUID(),
        evidenceRunId,
        clusteringRunId,
        batchId,
        signalRunId,
        incidentIds[0],
        signalId,
      ],
    );
    for (const incidentId of incidentIds) {
      await tx.query(
        `INSERT INTO incident_evidence_states (
           id, evidence_run_id, clustering_run_id, batch_id, signal_run_id, incident_cluster_id,
           state, reason_code, claim_id, accepted_association_count, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'reported_only', 'no_accepted_association', NULL, 0,
                   now())`,
        [randomUUID(), evidenceRunId, clusteringRunId, batchId, signalRunId, incidentId],
      );
    }
    await tx.query(
      `UPDATE evidence_runs
          SET status = 'completed', incident_count = 2, signal_count = 1, suggestion_count = 1,
              reported_only_count = 2, onchain_observed_count = 0, corroborated_count = 0,
              contradicted_count = 0, completed_at = now()
        WHERE id = $1`,
      [evidenceRunId],
    );
  });
  return {
    batchId,
    classificationRunId,
    clusteringRunId,
    incidentIds,
    reviewRowId: rowIds[1] ?? '',
    signalRunId,
    evidenceRunId,
  };
}

describe('dashboard reads', () => {
  let isolated: IsolatedSchema;
  let seeded: Seeded;
  let other: Seeded;

  beforeAll(async () => {
    isolated = await openIsolatedSchema();
    await runMigrations(isolated.db);
    seeded = await seed(isolated.db);
    other = await seed(isolated.db);
  });

  afterAll(async () => {
    await isolated.close();
  });

  it('counts what the store holds', async () => {
    const totals = await isolated.db.withClient((client) => countDashboardTotals(client));
    expect(totals).toEqual({
      importBatches: 2,
      classificationRuns: 2,
      clusteringRuns: 2,
      graphSignalRuns: 2,
      evidenceRuns: 2,
    });
  });

  it('lists runs newest first with their counts and origin', async () => {
    const clustering = await isolated.db.withClient((client) => listClusteringRuns(client, 10));
    expect(clustering.map((run) => run.id)).toContain(seeded.clusteringRunId);
    expect(clustering[0]?.dataOrigin).toBe('replay');
    const evidence = await isolated.db.withClient((client) => listEvidenceRuns(client, 10));
    expect(evidence.find((run) => run.id === seeded.evidenceRunId)?.reportedOnlyCount).toBe(2);
    const signals = await isolated.db.withClient((client) => listGraphSignalRuns(client, 10));
    expect(signals.find((run) => run.id === seeded.signalRunId)?.gatewayHost).toBe(
      'gateway.example',
    );
  });

  it('refuses a page size outside the bound', async () => {
    for (const limit of [0, 501, -1, 1.5]) {
      await expect(
        isolated.db.withClient((client) => listClusteringRuns(client, limit)),
      ).rejects.toSatisfy((error) => isDatabaseError(error) && error.kind === 'query');
    }
  });

  it('pages incident clusters by identifier with the recorded subject beside each', async () => {
    const first = await isolated.db.withClient((client) =>
      listIncidentClusters(client, seeded.clusteringRunId, { afterId: null, limit: 1 }),
    );
    expect(first).toHaveLength(1);
    expect(first[0]?.id).toBe(seeded.incidentIds[0]);
    expect(first[0]?.subjectChain).toBe('ethereum');
    expect(first[0]?.subjectProtocolSlug).toBe('aave-v3');
    const second = await isolated.db.withClient((client) =>
      listIncidentClusters(client, seeded.clusteringRunId, {
        afterId: first[0]?.id ?? null,
        limit: 10,
      }),
    );
    expect(second.map((cluster) => cluster.id)).toEqual([seeded.incidentIds[1]]);
    expect(second[0]?.subjectChain).toBeNull();
  });

  it('reads an incident only under the run that owns it', async () => {
    const own = await isolated.db.withClient((client) =>
      getIncidentCluster(client, seeded.clusteringRunId, seeded.incidentIds[0] ?? ''),
    );
    expect(own?.memberCount).toBe(2);
    const crossRun = await isolated.db.withClient((client) =>
      getIncidentCluster(client, other.clusteringRunId, seeded.incidentIds[0] ?? ''),
    );
    expect(crossRun).toBeNull();
    const members = await isolated.db.withClient((client) =>
      listIncidentMembers(client, other.clusteringRunId, seeded.incidentIds[0] ?? '', {
        limit: 10,
        withText: true,
        maxTextCharacters: 200,
      }),
    );
    expect(members).toEqual([]);
  });

  it('selects no text unless asked, and bounds it when asked', async () => {
    const withoutText = await isolated.db.withClient((client) =>
      listIncidentMembers(client, seeded.clusteringRunId, seeded.incidentIds[0] ?? '', {
        limit: 10,
        withText: false,
        maxTextCharacters: 200,
      }),
    );
    expect(withoutText).toHaveLength(2);
    for (const member of withoutText) {
      expect(member.title).toBeNull();
      expect(member.publisher).toBeNull();
      expect(member.url).toBeNull();
    }
    const withText = await isolated.db.withClient((client) =>
      listIncidentMembers(client, seeded.clusteringRunId, seeded.incidentIds[0] ?? '', {
        limit: 10,
        withText: true,
        maxTextCharacters: 8,
      }),
    );
    expect(withText[0]?.title).toBe(HOSTILE_TITLE.slice(0, 8));
    expect(withText[0]?.publisher).toBe('Security');
  });

  it('derives the queue from the run without joining a review table, text on request only', async () => {
    const hidden = await isolated.db.withClient((client) =>
      listReviewQueueEntries(client, seeded.classificationRunId, {
        afterRowNumber: 0,
        limit: 10,
        withText: false,
        maxTextCharacters: 100,
      }),
    );
    expect(hidden).toHaveLength(1);
    expect(hidden[0]?.sourceRowId).toBe(seeded.reviewRowId);
    expect(hidden[0]?.title).toBeNull();
    expect(hidden[0]?.summary).toBeNull();
    const shown = await isolated.db.withClient((client) =>
      listReviewQueueEntries(client, seeded.classificationRunId, {
        afterRowNumber: 0,
        limit: 10,
        withText: true,
        maxTextCharacters: 100,
      }),
    );
    expect(shown[0]?.title).toBe('A second invented headline');
    expect(shown[0]?.summary).toBe('summary 1');
    const after = await isolated.db.withClient((client) =>
      listReviewQueueEntries(client, seeded.classificationRunId, {
        afterRowNumber: 2,
        limit: 10,
        withText: false,
        maxTextCharacters: 100,
      }),
    );
    expect(after).toEqual([]);
  });

  it('refuses a text bound outside the permitted range', async () => {
    await expect(
      isolated.db.withClient((client) =>
        listReviewQueueEntries(client, seeded.classificationRunId, {
          afterRowNumber: 0,
          limit: 10,
          withText: true,
          maxTextCharacters: 2001,
        }),
      ),
    ).rejects.toSatisfy((error) => isDatabaseError(error) && error.kind === 'query');
  });

  it('lists evidence states and association details with the effective status', async () => {
    const states = await isolated.db.withClient((client) =>
      listIncidentEvidenceStates(client, seeded.evidenceRunId, 10),
    );
    expect(states.map((state) => state.incidentId)).toEqual(seeded.incidentIds);
    expect(states[0]?.hasSubject).toBe(true);
    expect(states[1]?.hasSubject).toBe(false);
    const associations = await isolated.db.withClient((client) =>
      listAssociationDetails(client, seeded.evidenceRunId, 10),
    );
    expect(associations).toHaveLength(1);
    expect(associations[0]?.effectiveStatus).toBe('suggested');
    expect(associations[0]?.suggestedRelation).toBe('context');
    expect(associations[0]?.protocolSlug).toBe('aave-v3');
    expect(associations[0]?.deltaPercent).toBe('-10');
    const foreign = await isolated.db.withClient((client) =>
      listAssociationDetails(client, other.evidenceRunId, 10),
    );
    expect(foreign[0]?.incidentId).not.toBe(seeded.incidentIds[0]);
  });
});
