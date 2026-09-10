import type { AssociationRelation, AssociationStatus, ChainId, DataOrigin } from '@cas/contracts';

import type { Queryable } from './database.js';
import { DatabaseError } from './errors.js';

/**
 * Read operations for the authenticated dashboard (parallel Sprint 6 track).
 *
 * Every statement is parameterized and every list is an explicit bounded page,
 * as everywhere else in this package. Two rules are specific to this file:
 *
 *   1. **Source text is selected only when the caller says so.** Each read that
 *      can carry a title, a derived summary or a URL takes a `withText` flag.
 *      When it is false the statement selects `NULL` in those positions, so the
 *      text never leaves the database for a caller that is not allowed to show
 *      it. The dashboard's data-access layer passes `false` for a judge.
 *
 *   2. **An object is read under the run that owns it.** `getIncidentCluster`
 *      and `listIncidentMembers` require both the clustering run and the
 *      incident, and the statement joins on both, so a caller that knows an
 *      identifier from another run reads nothing.
 *
 * Nothing here writes. Nothing here reads a raw cell, a `ch` value, a weekly
 * review state, a password or a session.
 */

const MAX_PAGE = 500;
const MAX_TEXT = 2000;

function assertPage(limit: number, label: string): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw new DatabaseError('query', `${label} page size outside the permitted range`);
  }
}

function assertText(maxTextCharacters: number): void {
  if (
    !Number.isSafeInteger(maxTextCharacters) ||
    maxTextCharacters < 1 ||
    maxTextCharacters > MAX_TEXT
  ) {
    throw new DatabaseError('query', 'text bound outside the permitted range');
  }
}

// ------------------------------------------------------------------- totals

export interface DashboardTotals {
  readonly importBatches: number;
  readonly classificationRuns: number;
  readonly clusteringRuns: number;
  readonly graphSignalRuns: number;
  readonly evidenceRuns: number;
}

/** Count-only overview of what the store holds. */
export async function countDashboardTotals(client: Queryable): Promise<DashboardTotals> {
  const result = await client.query<{
    batches: string;
    classification: string;
    clustering: string;
    signals: string;
    evidence: string;
  }>(
    `SELECT (SELECT count(*) FROM import_batches)::text AS batches,
            (SELECT count(*) FROM classification_runs)::text AS classification,
            (SELECT count(*) FROM clustering_runs)::text AS clustering,
            (SELECT count(*) FROM graph_signal_runs)::text AS signals,
            (SELECT count(*) FROM evidence_runs)::text AS evidence`,
  );
  const row = result.rows[0];
  return {
    importBatches: Number(row?.batches ?? '0'),
    classificationRuns: Number(row?.classification ?? '0'),
    clusteringRuns: Number(row?.clustering ?? '0'),
    graphSignalRuns: Number(row?.signals ?? '0'),
    evidenceRuns: Number(row?.evidence ?? '0'),
  };
}

// --------------------------------------------------------------------- runs

export interface ClusteringRunSummary {
  readonly id: string;
  readonly classificationRunId: string;
  readonly batchId: string;
  readonly dataOrigin: DataOrigin;
  readonly status: 'running' | 'completed';
  readonly incidentCount: number;
  readonly multiSourceIncidentCount: number;
  readonly ambiguousLinkCount: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

/** Clustering runs, newest first, bounded. */
export async function listClusteringRuns(
  client: Queryable,
  limit: number,
): Promise<ClusteringRunSummary[]> {
  assertPage(limit, 'clustering run');
  const result = await client.query<{
    id: string;
    classification_run_id: string;
    batch_id: string;
    data_origin: DataOrigin;
    status: 'running' | 'completed';
    incident_count: number;
    multi_source_incident_count: number;
    ambiguous_link_count: number;
    started_at: string;
    completed_at: string | null;
  }>(
    `SELECT id, classification_run_id, batch_id, data_origin, status, incident_count,
            multi_source_incident_count, ambiguous_link_count,
            to_json(started_at) #>> '{}' AS started_at,
            to_json(completed_at) #>> '{}' AS completed_at
       FROM clustering_runs ORDER BY started_at DESC, id LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    classificationRunId: row.classification_run_id,
    batchId: row.batch_id,
    dataOrigin: row.data_origin,
    status: row.status,
    incidentCount: row.incident_count,
    multiSourceIncidentCount: row.multi_source_incident_count,
    ambiguousLinkCount: row.ambiguous_link_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

export interface EvidenceRunSummary {
  readonly id: string;
  readonly clusteringRunId: string;
  readonly batchId: string;
  readonly signalRunId: string;
  readonly dataOrigin: DataOrigin;
  readonly status: 'running' | 'completed';
  readonly incidentCount: number;
  readonly suggestionCount: number;
  readonly reportedOnlyCount: number;
  readonly onchainObservedCount: number;
  readonly corroboratedCount: number;
  readonly contradictedCount: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

/** Evidence runs, newest first, bounded. */
export async function listEvidenceRuns(
  client: Queryable,
  limit: number,
): Promise<EvidenceRunSummary[]> {
  assertPage(limit, 'evidence run');
  const result = await client.query<{
    id: string;
    clustering_run_id: string;
    batch_id: string;
    signal_run_id: string;
    data_origin: DataOrigin;
    status: 'running' | 'completed';
    incident_count: number;
    suggestion_count: number;
    reported_only_count: number;
    onchain_observed_count: number;
    corroborated_count: number;
    contradicted_count: number;
    started_at: string;
    completed_at: string | null;
  }>(
    `SELECT id, clustering_run_id, batch_id, signal_run_id, data_origin, status, incident_count,
            suggestion_count, reported_only_count, onchain_observed_count, corroborated_count,
            contradicted_count, to_json(started_at) #>> '{}' AS started_at,
            to_json(completed_at) #>> '{}' AS completed_at
       FROM evidence_runs ORDER BY started_at DESC, id LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    clusteringRunId: row.clustering_run_id,
    batchId: row.batch_id,
    signalRunId: row.signal_run_id,
    dataOrigin: row.data_origin,
    status: row.status,
    incidentCount: row.incident_count,
    suggestionCount: row.suggestion_count,
    reportedOnlyCount: row.reported_only_count,
    onchainObservedCount: row.onchain_observed_count,
    corroboratedCount: row.corroborated_count,
    contradictedCount: row.contradicted_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

export interface GraphSignalRunSummary {
  readonly id: string;
  readonly dataOrigin: DataOrigin;
  readonly status: 'running' | 'completed';
  readonly gatewayHost: string;
  readonly targetCount: number;
  readonly signalCount: number;
  readonly failedTargetCount: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

/** Graph signal runs, newest first, bounded. The host is a validated hostname, never a URL. */
export async function listGraphSignalRuns(
  client: Queryable,
  limit: number,
): Promise<GraphSignalRunSummary[]> {
  assertPage(limit, 'signal run');
  const result = await client.query<{
    id: string;
    data_origin: DataOrigin;
    status: 'running' | 'completed';
    gateway_host: string;
    target_count: number;
    signal_count: number;
    failed_target_count: number;
    started_at: string;
    completed_at: string | null;
  }>(
    `SELECT id, data_origin, status, gateway_host, target_count, signal_count,
            failed_target_count, to_json(started_at) #>> '{}' AS started_at,
            to_json(completed_at) #>> '{}' AS completed_at
       FROM graph_signal_runs ORDER BY started_at DESC, id LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    dataOrigin: row.data_origin,
    status: row.status,
    gatewayHost: row.gateway_host,
    targetCount: row.target_count,
    signalCount: row.signal_count,
    failedTargetCount: row.failed_target_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

// ---------------------------------------------------------------- incidents

export interface IncidentClusterSummary {
  readonly id: string;
  readonly clusteringRunId: string;
  readonly batchId: string;
  readonly kind: string;
  readonly memberCount: number;
  readonly reasonCodes: readonly string[];
  readonly representativeSourceRowId: string;
  /** The recorded subject, when a person has recorded one. */
  readonly subjectChain: ChainId | null;
  readonly subjectProtocolSlug: string | null;
  readonly createdAt: string;
}

const CLUSTER_COLUMNS = `c.id, c.clustering_run_id, c.batch_id, c.kind, c.member_count,
  c.reason_codes, c.representative_source_row_id, s.chain AS subject_chain,
  s.protocol_slug AS subject_protocol_slug, to_json(c.created_at) #>> '{}' AS created_at`;

interface ClusterRow {
  id: string;
  clustering_run_id: string;
  batch_id: string;
  kind: string;
  member_count: number;
  reason_codes: string[];
  representative_source_row_id: string;
  subject_chain: ChainId | null;
  subject_protocol_slug: string | null;
  created_at: string;
}

function toCluster(row: ClusterRow): IncidentClusterSummary {
  return {
    id: row.id,
    clusteringRunId: row.clustering_run_id,
    batchId: row.batch_id,
    kind: row.kind,
    memberCount: row.member_count,
    reasonCodes: row.reason_codes,
    representativeSourceRowId: row.representative_source_row_id,
    subjectChain: row.subject_chain,
    subjectProtocolSlug: row.subject_protocol_slug,
    createdAt: row.created_at,
  };
}

/**
 * One bounded keyset page of the machine's base incident clusters for one run,
 * in identifier order, with the recorded subject beside each. No text.
 */
export async function listIncidentClusters(
  client: Queryable,
  clusteringRunId: string,
  options: { readonly afterId: string | null; readonly limit: number },
): Promise<IncidentClusterSummary[]> {
  assertPage(options.limit, 'incident');
  const result = await client.query<ClusterRow>(
    `SELECT ${CLUSTER_COLUMNS}
       FROM incident_clusters c
       LEFT JOIN incident_subjects s
              ON s.incident_cluster_id = c.id AND s.clustering_run_id = c.clustering_run_id
      WHERE c.clustering_run_id = $1 AND ($2::uuid IS NULL OR c.id > $2::uuid)
      ORDER BY c.id
      LIMIT $3`,
    [clusteringRunId, options.afterId, options.limit],
  );
  return result.rows.map(toCluster);
}

/** One cluster, only when it belongs to the named run. */
export async function getIncidentCluster(
  client: Queryable,
  clusteringRunId: string,
  incidentId: string,
): Promise<IncidentClusterSummary | null> {
  const result = await client.query<ClusterRow>(
    `SELECT ${CLUSTER_COLUMNS}
       FROM incident_clusters c
       LEFT JOIN incident_subjects s
              ON s.incident_cluster_id = c.id AND s.clustering_run_id = c.clustering_run_id
      WHERE c.clustering_run_id = $1 AND c.id = $2`,
    [clusteringRunId, incidentId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toCluster(row);
}

export interface IncidentMemberSummary {
  readonly membershipId: string;
  readonly sourceRowId: string;
  readonly rowNumber: number;
  readonly dataOrigin: DataOrigin;
  readonly decision: string;
  readonly postedAt: string | null;
  /** Present only when the read was made with `withText`. */
  readonly title: string | null;
  readonly publisher: string | null;
  readonly url: string | null;
}

/**
 * The memberships of one incident of one run, bounded. Text columns are
 * selected as `NULL` unless `withText` is true, and bounded in the database
 * when they are selected.
 */
export async function listIncidentMembers(
  client: Queryable,
  clusteringRunId: string,
  incidentId: string,
  options: {
    readonly limit: number;
    readonly withText: boolean;
    readonly maxTextCharacters: number;
  },
): Promise<IncidentMemberSummary[]> {
  assertPage(options.limit, 'membership');
  assertText(options.maxTextCharacters);
  const result = await client.query<{
    membership_id: string;
    source_row_id: string;
    row_number: number;
    data_origin: DataOrigin;
    decision: string;
    posted_at: string | null;
    title: string | null;
    publisher: string | null;
    url: string | null;
  }>(
    `SELECT m.id AS membership_id, m.source_row_id, r.row_number, m.data_origin, m.decision,
            to_json(r.posted_at) #>> '{}' AS posted_at,
            CASE WHEN $4::boolean THEN left(r.normalized_title, $5) ELSE NULL END AS title,
            CASE WHEN $4::boolean THEN left(r.raw_category, $5) ELSE NULL END AS publisher,
            CASE WHEN $4::boolean THEN left(r.canonical_url, $5) ELSE NULL END AS url
       FROM incident_memberships m
       JOIN source_rows r ON r.id = m.source_row_id AND r.batch_id = m.batch_id
      WHERE m.clustering_run_id = $1 AND m.incident_cluster_id = $2
      ORDER BY r.row_number
      LIMIT $3`,
    [clusteringRunId, incidentId, options.limit, options.withText, options.maxTextCharacters],
  );
  return result.rows.map((row) => ({
    membershipId: row.membership_id,
    sourceRowId: row.source_row_id,
    rowNumber: row.row_number,
    dataOrigin: row.data_origin,
    decision: row.decision,
    postedAt: row.posted_at,
    title: row.title,
    publisher: row.publisher,
    url: row.url,
  }));
}

// -------------------------------------------------------------------- queue

export interface ReviewQueueEntry {
  readonly sourceRowId: string;
  readonly batchId: string;
  readonly rowNumber: number;
  readonly dataOrigin: DataOrigin;
  readonly rationaleCodes: readonly string[];
  readonly signalScore: number;
  readonly postedAt: string | null;
  /** Present only when the read was made with `withText`. */
  readonly title: string | null;
  readonly summary: string | null;
  readonly url: string | null;
}

/**
 * The needs-review queue of one explicit classification run, one bounded
 * keyset page. Text is selected only with `withText`, bounded in the database.
 * This joins no human review table: the queue is derived from the run.
 */
export async function listReviewQueueEntries(
  client: Queryable,
  classificationRunId: string,
  options: {
    readonly afterRowNumber: number;
    readonly limit: number;
    readonly withText: boolean;
    readonly maxTextCharacters: number;
  },
): Promise<ReviewQueueEntry[]> {
  assertPage(options.limit, 'queue');
  assertText(options.maxTextCharacters);
  const result = await client.query<{
    source_row_id: string;
    batch_id: string;
    row_number: number;
    data_origin: DataOrigin;
    rationale_codes: string[];
    signal_score: number;
    posted_at: string | null;
    title: string | null;
    summary: string | null;
    url: string | null;
  }>(
    `SELECT c.source_row_id, c.batch_id, r.row_number, r.data_origin, c.rationale_codes,
            c.signal_score, to_json(r.posted_at) #>> '{}' AS posted_at,
            CASE WHEN $4::boolean THEN left(r.normalized_title, $5) ELSE NULL END AS title,
            CASE WHEN $4::boolean THEN left(r.derived_summary_text, $5) ELSE NULL END AS summary,
            CASE WHEN $4::boolean THEN left(r.canonical_url, $5) ELSE NULL END AS url
       FROM classification_results c
       JOIN source_rows r ON r.id = c.source_row_id AND r.batch_id = c.batch_id
      WHERE c.run_id = $1 AND c.decision = 'review' AND r.row_number > $2
      ORDER BY r.row_number
      LIMIT $3`,
    [
      classificationRunId,
      options.afterRowNumber,
      options.limit,
      options.withText,
      options.maxTextCharacters,
    ],
  );
  return result.rows.map((row) => ({
    sourceRowId: row.source_row_id,
    batchId: row.batch_id,
    rowNumber: row.row_number,
    dataOrigin: row.data_origin,
    rationaleCodes: row.rationale_codes,
    signalScore: row.signal_score,
    postedAt: row.posted_at,
    title: row.title,
    summary: row.summary,
    url: row.url,
  }));
}

// ----------------------------------------------------------------- evidence

export interface IncidentEvidenceStateSummary {
  readonly incidentId: string;
  readonly state: string;
  readonly reasonCode: string;
  readonly claimId: string | null;
  readonly acceptedAssociationCount: number;
  readonly hasSubject: boolean;
}

/** Resolved states of one evidence run, bounded, in incident order. */
export async function listIncidentEvidenceStates(
  client: Queryable,
  evidenceRunId: string,
  limit: number,
): Promise<IncidentEvidenceStateSummary[]> {
  assertPage(limit, 'evidence state');
  const result = await client.query<{
    incident_cluster_id: string;
    state: string;
    reason_code: string;
    claim_id: string | null;
    accepted_association_count: number;
    has_subject: boolean;
  }>(
    `SELECT s.incident_cluster_id, s.state, s.reason_code, s.claim_id,
            s.accepted_association_count, (sub.id IS NOT NULL) AS has_subject
       FROM incident_evidence_states s
       LEFT JOIN incident_subjects sub
              ON sub.incident_cluster_id = s.incident_cluster_id
             AND sub.clustering_run_id = s.clustering_run_id
      WHERE s.evidence_run_id = $1
      ORDER BY s.incident_cluster_id
      LIMIT $2`,
    [evidenceRunId, limit],
  );
  return result.rows.map((row) => ({
    incidentId: row.incident_cluster_id,
    state: row.state,
    reasonCode: row.reason_code,
    claimId: row.claim_id,
    acceptedAssociationCount: row.accepted_association_count,
    hasSubject: row.has_subject,
  }));
}

export interface AssociationDetail {
  readonly associationId: string;
  readonly incidentId: string;
  readonly signalId: string;
  readonly chain: ChainId;
  readonly protocolSlug: string;
  readonly observedAt: string;
  readonly deltaPercent: string;
  readonly offsetSeconds: number;
  readonly reasonCodes: readonly string[];
  readonly suggestedRelation: AssociationRelation;
  readonly effectiveRelation: AssociationRelation;
  readonly effectiveStatus: AssociationStatus;
  readonly effectiveClaimId: string | null;
}

/**
 * Every association of one evidence run with its effective status, bounded.
 *
 * The effective status is derived exactly as `listEffectiveAssociations`
 * derives it: the machine's suggestion plus the latest decision recorded for
 * the same incident and signal under the same clustering run. The suggestion
 * row itself is never edited, so the machine's relation is returned beside the
 * effective one rather than replaced by it.
 */
export async function listAssociationDetails(
  client: Queryable,
  evidenceRunId: string,
  limit: number,
): Promise<AssociationDetail[]> {
  assertPage(limit, 'association');
  const result = await client.query<{
    id: string;
    incident_cluster_id: string;
    signal_id: string;
    chain: ChainId;
    protocol_slug: string;
    observed_at: string;
    delta_percent: string;
    offset_seconds: number;
    reason_codes: string[];
    suggested_relation: AssociationRelation;
    effective_relation: AssociationRelation;
    effective_status: AssociationStatus;
    effective_claim_id: string | null;
  }>(
    `SELECT a.id, a.incident_cluster_id, a.signal_id, a.chain, g.protocol_slug,
            to_json(g.observed_at) #>> '{}' AS observed_at,
            g.delta_percent::text AS delta_percent, a.offset_seconds, a.reason_codes,
            a.relation AS suggested_relation,
            coalesce(latest.relation, a.relation) AS effective_relation,
            coalesce(latest.status, a.status) AS effective_status,
            coalesce(latest.claim_id, a.claim_id) AS effective_claim_id
       FROM incident_signal_associations a
       JOIN graph_signals g ON g.id = a.signal_id
       LEFT JOIN LATERAL (
         SELECT CASE WHEN r.operation = 'accept' THEN 'accepted' ELSE 'rejected' END AS status,
                r.relation, r.claim_id
           FROM evidence_review_actions r
           JOIN incident_signal_associations d ON d.id = r.association_id
          WHERE d.clustering_run_id = a.clustering_run_id
            AND d.incident_cluster_id = a.incident_cluster_id
            AND d.signal_id = a.signal_id
          ORDER BY r.created_at DESC, r.resulting_revision DESC, r.id DESC
          LIMIT 1
       ) latest ON true
      WHERE a.evidence_run_id = $1
      ORDER BY a.incident_cluster_id, a.signal_id
      LIMIT $2`,
    [evidenceRunId, limit],
  );
  return result.rows.map((row) => ({
    associationId: row.id,
    incidentId: row.incident_cluster_id,
    signalId: row.signal_id,
    chain: row.chain,
    protocolSlug: row.protocol_slug,
    observedAt: row.observed_at,
    deltaPercent: row.delta_percent,
    offsetSeconds: row.offset_seconds,
    reasonCodes: row.reason_codes,
    suggestedRelation: row.suggested_relation,
    effectiveRelation: row.effective_relation,
    effectiveStatus: row.effective_status,
    effectiveClaimId: row.effective_claim_id,
  }));
}

/** One queue entry of one run, or null when the row is not in that run's queue. */
export async function findReviewQueueEntry(
  client: Queryable,
  classificationRunId: string,
  sourceRowId: string,
  options: { readonly withText: boolean; readonly maxTextCharacters: number },
): Promise<ReviewQueueEntry | null> {
  assertText(options.maxTextCharacters);
  const result = await client.query<{
    source_row_id: string;
    batch_id: string;
    row_number: number;
    data_origin: DataOrigin;
    rationale_codes: string[];
    signal_score: number;
    posted_at: string | null;
    title: string | null;
    summary: string | null;
    url: string | null;
  }>(
    `SELECT c.source_row_id, c.batch_id, r.row_number, r.data_origin, c.rationale_codes,
            c.signal_score, to_json(r.posted_at) #>> '{}' AS posted_at,
            CASE WHEN $3::boolean THEN left(r.normalized_title, $4) ELSE NULL END AS title,
            CASE WHEN $3::boolean THEN left(r.derived_summary_text, $4) ELSE NULL END AS summary,
            CASE WHEN $3::boolean THEN left(r.canonical_url, $4) ELSE NULL END AS url
       FROM classification_results c
       JOIN source_rows r ON r.id = c.source_row_id AND r.batch_id = c.batch_id
      WHERE c.run_id = $1 AND c.source_row_id = $2 AND c.decision = 'review'`,
    [classificationRunId, sourceRowId, options.withText, options.maxTextCharacters],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    sourceRowId: row.source_row_id,
    batchId: row.batch_id,
    rowNumber: row.row_number,
    dataOrigin: row.data_origin,
    rationaleCodes: row.rationale_codes,
    signalScore: row.signal_score,
    postedAt: row.posted_at,
    title: row.title,
    summary: row.summary,
    url: row.url,
  };
}
