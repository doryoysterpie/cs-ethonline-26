import type { DataOrigin } from '@cas/contracts';

import type { Queryable } from './database.js';
import { DatabaseError } from './errors.js';
import { MAX_ROWS_PER_INSERT } from './ingestion.js';

/**
 * Clustering persistence (Sprint 4, decision D22).
 *
 * The same shape as the Sprint 3 classification operations: parameterized
 * statements only, bounded deterministic paging, count-only aggregates, and a
 * run that is inserted `running` and completed through a transition the
 * database validates for itself. Nothing here reads a review state, a weekly
 * label, a publisher category or a `ch` value.
 */

export interface ClusteringInputRow {
  readonly sourceRowId: string;
  readonly rowHash: string;
  readonly classificationResultId: string;
  readonly classificationRunId: string;
  readonly batchId: string;
  readonly dataOrigin: string;
  readonly decision: string;
  readonly urlGroupId: string | null;
  readonly postedAt: string | null;
  readonly normalizedTitle: string | null;
  readonly derivedSummaryText: string | null;
  readonly derivedDescriptionText: string | null;
  /** Stable logical order for keyset paging; never given to the engine. */
  readonly rowNumber: number;
}

export interface NewClusteringRun {
  readonly id: string;
  readonly classificationRunId: string;
  readonly batchId: string;
  readonly dataOrigin: DataOrigin;
  readonly engineVersion: string;
  readonly contractVersion: string;
  readonly contractHash: string;
  readonly idempotencyKey: string;
  readonly startedAt: string;
}

export interface ClusteringCounts {
  readonly eligibleRowCount: number;
  readonly ineligibleRowCount: number;
  readonly duplicateGroupCount: number;
  readonly syndicationGroupCount: number;
  readonly incidentCount: number;
  readonly singletonIncidentCount: number;
  readonly multiSourceIncidentCount: number;
  readonly largestClusterSize: number;
  readonly ambiguousLinkCount: number;
}

export type ClusteringRunStatus = 'running' | 'completed';

export interface ClusteringRunRecord extends NewClusteringRun, ClusteringCounts {
  readonly status: ClusteringRunStatus;
  readonly completedAt: string | null;
}

export interface NewIncidentCluster {
  readonly id: string;
  readonly clusteringRunId: string;
  readonly batchId: string;
  readonly fingerprint: string;
  readonly kind: string;
  readonly memberCount: number;
  readonly duplicateGroupCount: number;
  readonly syndicationGroupCount: number;
  readonly reasonCodes: readonly string[];
  readonly representativeSourceRowId: string;
  readonly createdAt: string;
}

export interface NewIncidentMembership {
  readonly id: string;
  readonly clusteringRunId: string;
  readonly incidentClusterId: string;
  readonly batchId: string;
  readonly dataOrigin: DataOrigin;
  readonly sourceRowId: string;
  readonly rowHash: string;
  readonly classificationResultId: string;
  readonly classificationRunId: string;
  readonly decision: string;
  readonly duplicateFingerprint: string;
  readonly syndicationFingerprint: string;
  readonly createdAt: string;
}

export interface NewAmbiguousLink {
  readonly id: string;
  readonly clusteringRunId: string;
  readonly batchId: string;
  readonly leftFingerprint: string;
  readonly rightFingerprint: string;
  readonly reasonCodes: readonly string[];
  readonly similarity: number;
  readonly sharedSignals: number;
  readonly sharedRareSignals: number;
  readonly createdAt: string;
}

export interface NewReviewAction {
  readonly id: string;
  readonly clusteringRunId: string;
  readonly batchId: string;
  readonly operation: 'merge' | 'split';
  readonly reasonCode: string;
  readonly note: string | null;
  readonly actor: string;
  readonly priorRevision: number;
  /**
   * The revision the caller declared, or null when it declared none and let
   * the current revision stand. Part of the canonical payload because it is
   * part of what was asked for; migration 0007 requires it to agree with
   * `priorRevision` whenever it is present.
   */
  readonly expectedRevision: number | null;
  readonly idempotencyKey: string;
  readonly affectedIncidentIds: readonly string[];
  readonly affectedMembershipIds: readonly string[];
  readonly createdAt: string;
}

export interface ReviewActionRecord extends NewReviewAction {
  readonly resultingRevision: number;
  /**
   * SHA-256 of the canonical semantic payload, computed by the database as a
   * generated column (migration 0007). The application never writes it, so a
   * stored digest cannot disagree with the row it describes.
   */
  readonly payloadDigest: string;
}

const RUN_COLUMNS = `id, classification_run_id, batch_id, data_origin, engine_version,
  contract_version, contract_hash, idempotency_key, status, eligible_row_count,
  ineligible_row_count, duplicate_group_count, syndication_group_count, incident_count,
  singleton_incident_count, multi_source_incident_count, largest_cluster_size,
  ambiguous_link_count, to_json(started_at) #>> '{}' AS started_at,
  to_json(completed_at) #>> '{}' AS completed_at`;

interface RunRow {
  id: string;
  classification_run_id: string;
  batch_id: string;
  data_origin: DataOrigin;
  engine_version: string;
  contract_version: string;
  contract_hash: string;
  idempotency_key: string;
  status: ClusteringRunStatus;
  eligible_row_count: number;
  ineligible_row_count: number;
  duplicate_group_count: number;
  syndication_group_count: number;
  incident_count: number;
  singleton_incident_count: number;
  multi_source_incident_count: number;
  largest_cluster_size: number;
  ambiguous_link_count: number;
  started_at: string;
  completed_at: string | null;
}

function toRunRecord(row: RunRow): ClusteringRunRecord {
  return {
    id: row.id,
    classificationRunId: row.classification_run_id,
    batchId: row.batch_id,
    dataOrigin: row.data_origin,
    engineVersion: row.engine_version,
    contractVersion: row.contract_version,
    contractHash: row.contract_hash,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    eligibleRowCount: row.eligible_row_count,
    ineligibleRowCount: row.ineligible_row_count,
    duplicateGroupCount: row.duplicate_group_count,
    syndicationGroupCount: row.syndication_group_count,
    incidentCount: row.incident_count,
    singletonIncidentCount: row.singleton_incident_count,
    multiSourceIncidentCount: row.multi_source_incident_count,
    largestClusterSize: row.largest_cluster_size,
    ambiguousLinkCount: row.ambiguous_link_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function getClusteringRun(
  client: Queryable,
  id: string,
): Promise<ClusteringRunRecord | null> {
  const result = await client.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM clustering_runs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRunRecord(row);
}

export async function findClusteringRunByIdempotencyKey(
  client: Queryable,
  idempotencyKey: string,
): Promise<ClusteringRunRecord | null> {
  const result = await client.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM clustering_runs WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRunRecord(row);
}

export async function insertRunningClusteringRun(
  client: Queryable,
  run: NewClusteringRun,
): Promise<void> {
  await client.query(
    `INSERT INTO clustering_runs (
       id, classification_run_id, batch_id, data_origin, engine_version, contract_version,
       contract_hash, idempotency_key, status, eligible_row_count, ineligible_row_count,
       duplicate_group_count, syndication_group_count, incident_count, singleton_incident_count,
       multi_source_incident_count, largest_cluster_size, ambiguous_link_count, started_at,
       completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', 0, 0, 0, 0, 0, 0, 0, 0, 0,
               $9::timestamptz, NULL)`,
    [
      run.id,
      run.classificationRunId,
      run.batchId,
      run.dataOrigin,
      run.engineVersion,
      run.contractVersion,
      run.contractHash,
      run.idempotencyKey,
      run.startedAt,
    ],
  );
}

/**
 * Reads one bounded page of the eligible results of an explicit classification
 * run, joined to exactly the source-row fields the clustering contract admits.
 * Text is truncated in the database to the contract's own input limit, which
 * bounds memory without changing what the engine would have read: the
 * assembler truncates the joined text to the same limit anyway.
 */
export async function fetchClusteringInputs(
  client: Queryable,
  classificationRunId: string,
  options: {
    readonly afterRowNumber: number;
    readonly limit: number;
    readonly maxTextCharacters: number;
    readonly eligibleDecisions: readonly string[];
  },
): Promise<ClusteringInputRow[]> {
  if (options.limit < 1 || options.limit > MAX_ROWS_PER_INSERT) {
    throw new DatabaseError('query', 'clustering page size out of range', {
      details: { limit: options.limit },
    });
  }
  const result = await client.query<{
    source_row_id: string;
    row_hash: string;
    classification_result_id: string;
    classification_run_id: string;
    batch_id: string;
    data_origin: DataOrigin;
    decision: string;
    url_group_id: string | null;
    posted_at: string | null;
    normalized_title: string | null;
    derived_summary_text: string | null;
    derived_description_text: string | null;
    row_number: number;
  }>(
    `SELECT r.source_row_id, r.row_hash, r.id AS classification_result_id,
            r.run_id AS classification_run_id, r.batch_id, s.data_origin, r.decision,
            s.url_group_id, to_json(s.posted_at) #>> '{}' AS posted_at,
            left(s.normalized_title, $4) AS normalized_title,
            left(s.derived_summary_text, $4) AS derived_summary_text,
            left(s.derived_description_text, $4) AS derived_description_text,
            s.row_number
       FROM classification_results r
       JOIN source_rows s ON s.id = r.source_row_id AND s.batch_id = r.batch_id
      WHERE r.run_id = $1 AND r.decision = ANY($5::text[]) AND s.row_number > $2
      ORDER BY s.row_number
      LIMIT $3`,
    [
      classificationRunId,
      options.afterRowNumber,
      options.limit,
      options.maxTextCharacters,
      [...options.eligibleDecisions],
    ],
  );
  return result.rows.map((row) => ({
    sourceRowId: row.source_row_id,
    rowHash: row.row_hash,
    classificationResultId: row.classification_result_id,
    classificationRunId: row.classification_run_id,
    batchId: row.batch_id,
    dataOrigin: row.data_origin,
    decision: row.decision,
    urlGroupId: row.url_group_id,
    postedAt: row.posted_at,
    normalizedTitle: row.normalized_title,
    derivedSummaryText: row.derived_summary_text,
    derivedDescriptionText: row.derived_description_text,
    rowNumber: row.row_number,
  }));
}

/** Eligible and ineligible result counts for one classification run. */
export async function countClassificationEligibility(
  client: Queryable,
  classificationRunId: string,
  eligibleDecisions: readonly string[],
): Promise<{ readonly eligible: number; readonly ineligible: number }> {
  const result = await client.query<{ eligible: string; ineligible: string }>(
    `SELECT count(*) FILTER (WHERE decision = ANY($2::text[]))::text AS eligible,
            count(*) FILTER (WHERE NOT (decision = ANY($2::text[])))::text AS ineligible
       FROM classification_results WHERE run_id = $1`,
    [classificationRunId, [...eligibleDecisions]],
  );
  const row = result.rows[0];
  return { eligible: Number(row?.eligible ?? '0'), ineligible: Number(row?.ineligible ?? '0') };
}

function valuesFor(rowCount: number, columns: number, casts: readonly string[]): string {
  const rows: string[] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const params: string[] = [];
    for (let c = 0; c < columns; c += 1) {
      const cast = casts[c] ?? '';
      params.push(`$${r * columns + c + 1}${cast === '' ? '' : `::${cast}`}`);
    }
    rows.push(`(${params.join(', ')})`);
  }
  return rows.join(', ');
}

export async function insertIncidentClusters(
  client: Queryable,
  clusters: readonly NewIncidentCluster[],
): Promise<void> {
  if (clusters.length === 0) return;
  if (clusters.length > MAX_ROWS_PER_INSERT) {
    throw new DatabaseError('query', 'too many incident clusters in one statement');
  }
  const casts = ['', '', '', '', '', '', '', '', 'jsonb', '', 'timestamptz'];
  const values: unknown[] = [];
  for (const cluster of clusters) {
    values.push(
      cluster.id,
      cluster.clusteringRunId,
      cluster.batchId,
      cluster.fingerprint,
      cluster.kind,
      cluster.memberCount,
      cluster.duplicateGroupCount,
      cluster.syndicationGroupCount,
      JSON.stringify(cluster.reasonCodes),
      cluster.representativeSourceRowId,
      cluster.createdAt,
    );
  }
  await client.query(
    `INSERT INTO incident_clusters (
       id, clustering_run_id, batch_id, fingerprint, kind, member_count, duplicate_group_count,
       syndication_group_count, reason_codes, representative_source_row_id, created_at
     ) VALUES ${valuesFor(clusters.length, 11, casts)}`,
    values,
  );
}

export async function insertIncidentMemberships(
  client: Queryable,
  memberships: readonly NewIncidentMembership[],
): Promise<void> {
  if (memberships.length === 0) return;
  if (memberships.length > MAX_ROWS_PER_INSERT) {
    throw new DatabaseError('query', 'too many incident memberships in one statement');
  }
  const casts = ['', '', '', '', '', '', '', '', '', '', '', '', 'timestamptz'];
  const values: unknown[] = [];
  for (const membership of memberships) {
    values.push(
      membership.id,
      membership.clusteringRunId,
      membership.incidentClusterId,
      membership.batchId,
      membership.dataOrigin,
      membership.sourceRowId,
      membership.rowHash,
      membership.classificationResultId,
      membership.classificationRunId,
      membership.decision,
      membership.duplicateFingerprint,
      membership.syndicationFingerprint,
      membership.createdAt,
    );
  }
  await client.query(
    `INSERT INTO incident_memberships (
       id, clustering_run_id, incident_cluster_id, batch_id, data_origin, source_row_id,
       row_hash, classification_result_id, classification_run_id, decision,
       duplicate_fingerprint, syndication_fingerprint, created_at
     ) VALUES ${valuesFor(memberships.length, 13, casts)}`,
    values,
  );
}

export async function insertAmbiguousLinks(
  client: Queryable,
  links: readonly NewAmbiguousLink[],
): Promise<void> {
  if (links.length === 0) return;
  if (links.length > MAX_ROWS_PER_INSERT) {
    throw new DatabaseError('query', 'too many ambiguous links in one statement');
  }
  const casts = ['', '', '', '', '', 'jsonb', '', '', '', 'timestamptz'];
  const values: unknown[] = [];
  for (const link of links) {
    values.push(
      link.id,
      link.clusteringRunId,
      link.batchId,
      link.leftFingerprint,
      link.rightFingerprint,
      JSON.stringify(link.reasonCodes),
      link.similarity,
      link.sharedSignals,
      link.sharedRareSignals,
      link.createdAt,
    );
  }
  await client.query(
    `INSERT INTO clustering_ambiguous_links (
       id, clustering_run_id, batch_id, left_fingerprint, right_fingerprint, reason_codes,
       similarity, shared_signals, shared_rare_signals, created_at
     ) VALUES ${valuesFor(links.length, 10, casts)}`,
    values,
  );
}

/** Counters derived from what the run actually stored. */
export async function deriveClusteringCounts(
  client: Queryable,
  runId: string,
  classificationRunId: string,
  eligibleDecisions: readonly string[],
): Promise<ClusteringCounts> {
  const eligibility = await countClassificationEligibility(
    client,
    classificationRunId,
    eligibleDecisions,
  );
  const result = await client.query<{
    incidents: string;
    singletons: string;
    multi: string;
    largest: string;
    duplicates: string;
    syndications: string;
    links: string;
  }>(
    `SELECT (SELECT count(*) FROM incident_clusters WHERE clustering_run_id = $1)::text
              AS incidents,
            (SELECT count(*) FROM incident_clusters
              WHERE clustering_run_id = $1 AND member_count = 1)::text AS singletons,
            (SELECT count(*) FROM incident_clusters
              WHERE clustering_run_id = $1 AND member_count > 1)::text AS multi,
            (SELECT coalesce(max(member_count), 0) FROM incident_clusters
              WHERE clustering_run_id = $1)::text AS largest,
            (SELECT coalesce(sum(duplicate_group_count), 0) FROM incident_clusters
              WHERE clustering_run_id = $1)::text AS duplicates,
            (SELECT coalesce(sum(syndication_group_count), 0) FROM incident_clusters
              WHERE clustering_run_id = $1)::text AS syndications,
            (SELECT count(*) FROM clustering_ambiguous_links
              WHERE clustering_run_id = $1)::text AS links`,
    [runId],
  );
  const row = result.rows[0];
  return {
    eligibleRowCount: eligibility.eligible,
    ineligibleRowCount: eligibility.ineligible,
    duplicateGroupCount: Number(row?.duplicates ?? '0'),
    syndicationGroupCount: Number(row?.syndications ?? '0'),
    incidentCount: Number(row?.incidents ?? '0'),
    singletonIncidentCount: Number(row?.singletons ?? '0'),
    multiSourceIncidentCount: Number(row?.multi ?? '0'),
    largestClusterSize: Number(row?.largest ?? '0'),
    ambiguousLinkCount: Number(row?.links ?? '0'),
  };
}

/** Eligible results of the classification run with no membership in this clustering run. */
export async function countUncoveredEligibleResults(
  client: Queryable,
  runId: string,
  classificationRunId: string,
  eligibleDecisions: readonly string[],
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM classification_results r
      WHERE r.run_id = $2 AND r.decision = ANY($3::text[])
        AND NOT EXISTS (SELECT 1 FROM incident_memberships m
                         WHERE m.clustering_run_id = $1 AND m.source_row_id = r.source_row_id)`,
    [runId, classificationRunId, [...eligibleDecisions]],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** Memberships attached to a result the classifier did not make eligible. */
export async function countIneligibleMemberships(
  client: Queryable,
  runId: string,
  eligibleDecisions: readonly string[],
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM incident_memberships m
       JOIN classification_results r ON r.id = m.classification_result_id
      WHERE m.clustering_run_id = $1 AND NOT (r.decision = ANY($2::text[]))`,
    [runId, [...eligibleDecisions]],
  );
  return Number(result.rows[0]?.count ?? '0');
}

export async function completeClusteringRun(
  client: Queryable,
  runId: string,
  counts: ClusteringCounts,
  completedAt: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE clustering_runs
        SET status = 'completed', eligible_row_count = $2, ineligible_row_count = $3,
            duplicate_group_count = $4, syndication_group_count = $5, incident_count = $6,
            singleton_incident_count = $7, multi_source_incident_count = $8,
            largest_cluster_size = $9, ambiguous_link_count = $10,
            completed_at = $11::timestamptz
      WHERE id = $1 AND status = 'running'`,
    [
      runId,
      counts.eligibleRowCount,
      counts.ineligibleRowCount,
      counts.duplicateGroupCount,
      counts.syndicationGroupCount,
      counts.incidentCount,
      counts.singletonIncidentCount,
      counts.multiSourceIncidentCount,
      counts.largestClusterSize,
      counts.ambiguousLinkCount,
      completedAt,
    ],
  );
  if (result.rowCount !== 1) {
    throw new DatabaseError('query', 'clustering run was not in a completable state', {
      details: { runId },
    });
  }
}

/** Count-only review workload: ambiguous links plus memberships still marked review. */
export async function countClusteringReview(
  client: Queryable,
  runId: string,
): Promise<{ readonly ambiguousLinks: number; readonly reviewMemberships: number }> {
  const result = await client.query<{ links: string; memberships: string }>(
    `SELECT (SELECT count(*) FROM clustering_ambiguous_links WHERE clustering_run_id = $1)::text
              AS links,
            (SELECT count(*) FROM incident_memberships
              WHERE clustering_run_id = $1 AND decision = 'review')::text AS memberships`,
    [runId],
  );
  const row = result.rows[0];
  return {
    ambiguousLinks: Number(row?.links ?? '0'),
    reviewMemberships: Number(row?.memberships ?? '0'),
  };
}

/** Cluster kinds and their counts for one run, count-only. */
export async function countClustersByKind(
  client: Queryable,
  runId: string,
): Promise<{ readonly kind: string; readonly count: number }[]> {
  const result = await client.query<{ kind: string; count: string }>(
    `SELECT kind, count(*)::text AS count FROM incident_clusters
      WHERE clustering_run_id = $1 GROUP BY kind ORDER BY kind`,
    [runId],
  );
  return result.rows.map((row) => ({ kind: row.kind, count: Number(row.count) }));
}

// ---------------------------------------------------------------------------
// The human review layer.

const ACTION_COLUMNS = `id, clustering_run_id, batch_id, operation, reason_code, note, actor,
  prior_revision, expected_revision, resulting_revision, idempotency_key, payload_digest,
  affected_incident_ids, affected_membership_ids, to_json(created_at) #>> '{}' AS created_at`;

interface ActionRow {
  id: string;
  clustering_run_id: string;
  batch_id: string;
  operation: 'merge' | 'split';
  reason_code: string;
  note: string | null;
  actor: string;
  prior_revision: number;
  expected_revision: number | null;
  resulting_revision: number;
  idempotency_key: string;
  payload_digest: string;
  affected_incident_ids: string[];
  affected_membership_ids: string[];
  created_at: string;
}

function toActionRecord(row: ActionRow): ReviewActionRecord {
  return {
    id: row.id,
    clusteringRunId: row.clustering_run_id,
    batchId: row.batch_id,
    operation: row.operation,
    reasonCode: row.reason_code,
    note: row.note,
    actor: row.actor,
    priorRevision: row.prior_revision,
    expectedRevision: row.expected_revision,
    resultingRevision: row.resulting_revision,
    idempotencyKey: row.idempotency_key,
    payloadDigest: row.payload_digest,
    affectedIncidentIds: row.affected_incident_ids,
    affectedMembershipIds: row.affected_membership_ids,
    createdAt: row.created_at,
  };
}

/** Actions in revision order. The effective view is a replay of exactly this list. */
export async function listReviewActions(
  client: Queryable,
  runId: string,
): Promise<ReviewActionRecord[]> {
  const result = await client.query<ActionRow>(
    `SELECT ${ACTION_COLUMNS} FROM clustering_review_actions
      WHERE clustering_run_id = $1 ORDER BY resulting_revision`,
    [runId],
  );
  return result.rows.map(toActionRecord);
}

export async function currentReviewRevision(client: Queryable, runId: string): Promise<number> {
  const result = await client.query<{ revision: string }>(
    `SELECT coalesce(max(resulting_revision), 0)::text AS revision
       FROM clustering_review_actions WHERE clustering_run_id = $1`,
    [runId],
  );
  return Number(result.rows[0]?.revision ?? '0');
}

export async function findReviewActionByIdempotencyKey(
  client: Queryable,
  runId: string,
  idempotencyKey: string,
): Promise<ReviewActionRecord | null> {
  const result = await client.query<ActionRow>(
    `SELECT ${ACTION_COLUMNS} FROM clustering_review_actions
      WHERE clustering_run_id = $1 AND idempotency_key = $2`,
    [runId, idempotencyKey],
  );
  const row = result.rows[0];
  return row === undefined ? null : toActionRecord(row);
}

export async function insertReviewAction(
  client: Queryable,
  action: NewReviewAction,
): Promise<void> {
  await client.query(
    // `payload_digest` is GENERATED ALWAYS (migration 0007) and is therefore
    // absent here by design: the database derives the action's identity from
    // the row it actually stored.
    `INSERT INTO clustering_review_actions (
       id, clustering_run_id, batch_id, operation, reason_code, note, actor, prior_revision,
       expected_revision, resulting_revision, idempotency_key, affected_incident_ids,
       affected_membership_ids, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb,
       $14::timestamptz)`,
    [
      action.id,
      action.clusteringRunId,
      action.batchId,
      action.operation,
      action.reasonCode,
      action.note,
      action.actor,
      action.priorRevision,
      action.expectedRevision,
      action.priorRevision + 1,
      action.idempotencyKey,
      JSON.stringify(action.affectedIncidentIds),
      JSON.stringify(action.affectedMembershipIds),
      action.createdAt,
    ],
  );
}

export interface BaseMembership {
  readonly membershipId: string;
  readonly incidentClusterId: string;
  readonly sourceRowId: string;
}

/** Base memberships in deterministic order, the starting point for every replay. */
export async function listBaseMemberships(
  client: Queryable,
  runId: string,
): Promise<BaseMembership[]> {
  const result = await client.query<{
    id: string;
    incident_cluster_id: string;
    source_row_id: string;
  }>(
    `SELECT id, incident_cluster_id, source_row_id FROM incident_memberships
      WHERE clustering_run_id = $1 ORDER BY source_row_id`,
    [runId],
  );
  return result.rows.map((row) => ({
    membershipId: row.id,
    incidentClusterId: row.incident_cluster_id,
    sourceRowId: row.source_row_id,
  }));
}
