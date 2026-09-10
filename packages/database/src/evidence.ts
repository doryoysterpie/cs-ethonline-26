import type { AssociationRelation, AssociationStatus, ChainId, DataOrigin } from '@cas/contracts';

import type { Queryable } from './database.js';
import { DatabaseError } from './errors.js';

/**
 * Typed operations over the Sprint 5 evidence tables (migration 0008).
 *
 * Every statement is parameterized, every write names its whole provenance,
 * and every read is either an aggregate or an explicit bounded page. Nothing
 * here returns a provider payload, an Authorization header or a credential,
 * because migration 0008 stores none: what a caller can read back is the
 * sanitized target, the validated identity, the block context and a canonical
 * response digest.
 *
 * The run lifecycle follows Sprints 3 and 4 exactly: a run is inserted
 * `running`, its rows are written, and the transition to `completed` is
 * validated by the database against what was actually stored.
 */

export interface NewGraphSignalRun {
  readonly id: string;
  readonly dataOrigin: DataOrigin;
  readonly signalVersion: string;
  readonly contractVersion: string;
  readonly contractHash: string;
  readonly querySha256: string;
  /** Host alone. Never a URL, never a path, never a query string. */
  readonly gatewayHost: string;
  readonly idempotencyKey: string;
  readonly targetCount: number;
  readonly startedAt: string;
}

export interface GraphSignalRunRecord extends NewGraphSignalRun {
  readonly status: 'running' | 'completed';
  readonly signalCount: number;
  readonly failedTargetCount: number;
  readonly completedAt: string | null;
}

export interface NewGraphSignal {
  readonly id: string;
  readonly signalRunId: string;
  readonly dataOrigin: DataOrigin;
  readonly chain: ChainId;
  readonly protocolSlug: string;
  readonly subgraphDeploymentId: string | null;
  readonly blockNumber: number | null;
  readonly blockHash: string | null;
  readonly observedAt: string;
  readonly baselineObservedAt: string;
  readonly elapsedSeconds: number;
  readonly currentTvlUsd: string;
  readonly baselineTvlUsd: string;
  readonly deltaUsd: string;
  readonly deltaPercent: string;
  readonly responseDigest: string;
  readonly createdAt: string;
}

/** A stored signal reads back exactly as it was written; nothing is derived. */
export type GraphSignalRecord = NewGraphSignal;

export interface NewEvidenceRun {
  readonly id: string;
  readonly clusteringRunId: string;
  readonly batchId: string;
  readonly signalRunId: string;
  readonly dataOrigin: DataOrigin;
  readonly resolverVersion: string;
  readonly contractVersion: string;
  readonly contractHash: string;
  readonly idempotencyKey: string;
  readonly startedAt: string;
}

export interface EvidenceRunRecord extends NewEvidenceRun {
  readonly status: 'running' | 'completed';
  readonly incidentCount: number;
  readonly signalCount: number;
  readonly suggestionCount: number;
  readonly reportedOnlyCount: number;
  readonly onchainObservedCount: number;
  readonly corroboratedCount: number;
  readonly contradictedCount: number;
  readonly completedAt: string | null;
}

export interface NewIncidentSubject {
  readonly id: string;
  readonly clusteringRunId: string;
  readonly batchId: string;
  readonly incidentClusterId: string;
  readonly chain: ChainId;
  readonly protocolSlug: string;
  readonly actor: string;
  readonly reasonCode: string;
  readonly createdAt: string;
}

export interface NewAssociation {
  readonly id: string;
  readonly evidenceRunId: string;
  readonly clusteringRunId: string;
  readonly batchId: string;
  readonly signalRunId: string;
  readonly incidentClusterId: string;
  readonly signalId: string;
  readonly chain: ChainId;
  readonly claimId: string | null;
  readonly relation: AssociationRelation;
  readonly reasonCodes: readonly string[];
  readonly offsetSeconds: number;
  readonly createdAt: string;
}

export interface AssociationRecord extends NewAssociation {
  readonly status: AssociationStatus;
}

export interface NewEvidenceState {
  readonly id: string;
  readonly evidenceRunId: string;
  readonly clusteringRunId: string;
  readonly batchId: string;
  readonly signalRunId: string;
  readonly incidentClusterId: string;
  readonly state: string;
  readonly reasonCode: string;
  readonly claimId: string | null;
  readonly acceptedAssociationCount: number;
  readonly createdAt: string;
}

export interface NewEvidenceAction {
  readonly id: string;
  readonly evidenceRunId: string;
  readonly associationId: string;
  readonly operation: 'accept' | 'reject';
  readonly relation: AssociationRelation;
  readonly claimId: string | null;
  readonly reasonCode: string;
  readonly rationale: string | null;
  readonly actor: string;
  readonly priorRevision: number;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface EvidenceActionRecord extends NewEvidenceAction {
  readonly resultingRevision: number;
}

export interface EvidenceStateCounts {
  readonly total: number;
  readonly reportedOnly: number;
  readonly onchainObserved: number;
  readonly corroborated: number;
  readonly contradicted: number;
}

/** Rows written per statement, matching the Sprint 2 insert bound. */
export const MAX_EVIDENCE_ROWS_PER_INSERT = 500;

// ---------------------------------------------------------------- signal runs

export async function insertRunningGraphSignalRun(
  client: Queryable,
  run: NewGraphSignalRun,
): Promise<void> {
  await client.query(
    `INSERT INTO graph_signal_runs (
       id, data_origin, signal_version, contract_version, contract_hash, query_sha256,
       gateway_host, idempotency_key, status, target_count, signal_count, failed_target_count,
       started_at, completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9, 0, 0, $10::timestamptz, NULL)`,
    [
      run.id,
      run.dataOrigin,
      run.signalVersion,
      run.contractVersion,
      run.contractHash,
      run.querySha256,
      run.gatewayHost,
      run.idempotencyKey,
      run.targetCount,
      run.startedAt,
    ],
  );
}

export async function completeGraphSignalRun(
  client: Queryable,
  runId: string,
  signalCount: number,
  failedTargetCount: number,
  completedAt: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE graph_signal_runs
        SET status = 'completed', signal_count = $2, failed_target_count = $3,
            completed_at = $4::timestamptz
      WHERE id = $1 AND status = 'running'`,
    [runId, signalCount, failedTargetCount, completedAt],
  );
  if (result.rowCount !== 1) {
    throw new DatabaseError('query', 'graph signal run was not in a completable state', {
      details: { runId },
    });
  }
}

const SIGNAL_RUN_COLUMNS = `id, data_origin, signal_version, contract_version, contract_hash,
  query_sha256, gateway_host, idempotency_key, status, target_count, signal_count,
  failed_target_count, to_json(started_at) #>> '{}' AS started_at,
  to_json(completed_at) #>> '{}' AS completed_at`;

interface SignalRunRow {
  id: string;
  data_origin: DataOrigin;
  signal_version: string;
  contract_version: string;
  contract_hash: string;
  query_sha256: string;
  gateway_host: string;
  idempotency_key: string;
  status: 'running' | 'completed';
  target_count: number;
  signal_count: number;
  failed_target_count: number;
  started_at: string;
  completed_at: string | null;
}

function toSignalRun(row: SignalRunRow): GraphSignalRunRecord {
  return {
    id: row.id,
    dataOrigin: row.data_origin,
    signalVersion: row.signal_version,
    contractVersion: row.contract_version,
    contractHash: row.contract_hash,
    querySha256: row.query_sha256,
    gatewayHost: row.gateway_host,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    targetCount: row.target_count,
    signalCount: row.signal_count,
    failedTargetCount: row.failed_target_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function getGraphSignalRun(
  client: Queryable,
  id: string,
): Promise<GraphSignalRunRecord | null> {
  const result = await client.query<SignalRunRow>(
    `SELECT ${SIGNAL_RUN_COLUMNS} FROM graph_signal_runs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : toSignalRun(row);
}

export async function findGraphSignalRunByIdempotencyKey(
  client: Queryable,
  idempotencyKey: string,
): Promise<GraphSignalRunRecord | null> {
  const result = await client.query<SignalRunRow>(
    `SELECT ${SIGNAL_RUN_COLUMNS} FROM graph_signal_runs WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const row = result.rows[0];
  return row === undefined ? null : toSignalRun(row);
}

export async function insertGraphSignals(
  client: Queryable,
  signals: readonly NewGraphSignal[],
): Promise<void> {
  if (signals.length === 0) return;
  if (signals.length > MAX_EVIDENCE_ROWS_PER_INSERT) {
    throw new DatabaseError('query', 'more signals in one statement than the bound permits');
  }
  const columns = 17;
  const values: unknown[] = [];
  const rows: string[] = [];
  for (const [index, signal] of signals.entries()) {
    const base = index * columns;
    rows.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6},` +
        ` $${base + 7}, $${base + 8}, $${base + 9}::timestamptz, $${base + 10}::timestamptz,` +
        ` $${base + 11}, $${base + 12}::numeric, $${base + 13}::numeric, $${base + 14}::numeric,` +
        ` $${base + 15}::numeric, $${base + 16}, $${base + 17}::timestamptz)`,
    );
    values.push(
      signal.id,
      signal.signalRunId,
      signal.dataOrigin,
      signal.chain,
      signal.protocolSlug,
      signal.subgraphDeploymentId,
      signal.blockNumber,
      signal.blockHash,
      signal.observedAt,
      signal.baselineObservedAt,
      signal.elapsedSeconds,
      signal.currentTvlUsd,
      signal.baselineTvlUsd,
      signal.deltaUsd,
      signal.deltaPercent,
      signal.responseDigest,
      signal.createdAt,
    );
  }
  await client.query(
    `INSERT INTO graph_signals (
       id, signal_run_id, data_origin, chain, protocol_slug, subgraph_deployment_id,
       block_number, block_hash, observed_at, baseline_observed_at, elapsed_seconds,
       current_tvl_usd, baseline_tvl_usd, delta_usd, delta_percent, response_digest, created_at
     ) VALUES ${rows.join(', ')}`,
    values,
  );
}

const SIGNAL_COLUMNS = `id, signal_run_id, data_origin, chain, protocol_slug,
  subgraph_deployment_id, block_number, block_hash,
  to_json(observed_at) #>> '{}' AS observed_at,
  to_json(baseline_observed_at) #>> '{}' AS baseline_observed_at, elapsed_seconds,
  current_tvl_usd::text AS current_tvl_usd, baseline_tvl_usd::text AS baseline_tvl_usd,
  delta_usd::text AS delta_usd, delta_percent::text AS delta_percent, response_digest,
  to_json(created_at) #>> '{}' AS created_at`;

interface SignalRow {
  id: string;
  signal_run_id: string;
  data_origin: DataOrigin;
  chain: ChainId;
  protocol_slug: string;
  subgraph_deployment_id: string | null;
  block_number: string | null;
  block_hash: string | null;
  observed_at: string;
  baseline_observed_at: string;
  elapsed_seconds: number;
  current_tvl_usd: string;
  baseline_tvl_usd: string;
  delta_usd: string;
  delta_percent: string;
  response_digest: string;
  created_at: string;
}

function toSignal(row: SignalRow): GraphSignalRecord {
  return {
    id: row.id,
    signalRunId: row.signal_run_id,
    dataOrigin: row.data_origin,
    chain: row.chain,
    protocolSlug: row.protocol_slug,
    subgraphDeploymentId: row.subgraph_deployment_id,
    blockNumber: row.block_number === null ? null : Number(row.block_number),
    blockHash: row.block_hash,
    observedAt: row.observed_at,
    baselineObservedAt: row.baseline_observed_at,
    elapsedSeconds: row.elapsed_seconds,
    currentTvlUsd: row.current_tvl_usd,
    baselineTvlUsd: row.baseline_tvl_usd,
    deltaUsd: row.delta_usd,
    deltaPercent: row.delta_percent,
    responseDigest: row.response_digest,
    createdAt: row.created_at,
  };
}

/** One signal, by identifier. The only per-row read a command may perform. */
export async function getGraphSignal(
  client: Queryable,
  id: string,
): Promise<GraphSignalRecord | null> {
  const result = await client.query<SignalRow>(
    `SELECT ${SIGNAL_COLUMNS} FROM graph_signals WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : toSignal(row);
}

/** Every signal of one run, bounded. Used by correlation, never by a printer. */
export async function listSignalsForRun(
  client: Queryable,
  signalRunId: string,
  limit: number,
): Promise<GraphSignalRecord[]> {
  if (limit < 1 || limit > 10000) {
    throw new DatabaseError('query', 'signal page size outside the permitted range');
  }
  const result = await client.query<SignalRow>(
    `SELECT ${SIGNAL_COLUMNS} FROM graph_signals WHERE signal_run_id = $1
      ORDER BY chain, protocol_slug LIMIT $2`,
    [signalRunId, limit],
  );
  return result.rows.map(toSignal);
}

/** Observations of one target, oldest first, for the anomaly baseline. */
export async function listSignalHistory(
  client: Queryable,
  chain: ChainId,
  protocolSlug: string,
  limit: number,
): Promise<{ readonly observedAt: string; readonly deltaPercent: string }[]> {
  if (limit < 1 || limit > 10000) {
    throw new DatabaseError('query', 'history page size outside the permitted range');
  }
  const result = await client.query<{ observed_at: string; delta_percent: string }>(
    `SELECT to_json(observed_at) #>> '{}' AS observed_at, delta_percent::text AS delta_percent
       FROM graph_signals WHERE chain = $1 AND protocol_slug = $2
      ORDER BY observed_at DESC LIMIT $3`,
    [chain, protocolSlug, limit],
  );
  return result.rows
    .map((row) => ({ observedAt: row.observed_at, deltaPercent: row.delta_percent }))
    .reverse();
}

// -------------------------------------------------------------- evidence runs

export async function insertRunningEvidenceRun(
  client: Queryable,
  run: NewEvidenceRun,
): Promise<void> {
  await client.query(
    `INSERT INTO evidence_runs (
       id, clustering_run_id, batch_id, signal_run_id, data_origin, resolver_version,
       contract_version, contract_hash, idempotency_key, status, incident_count, signal_count,
       suggestion_count, reported_only_count, onchain_observed_count, corroborated_count,
       contradicted_count, started_at, completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'running', 0, 0, 0, 0, 0, 0, 0,
               $10::timestamptz, NULL)`,
    [
      run.id,
      run.clusteringRunId,
      run.batchId,
      run.signalRunId,
      run.dataOrigin,
      run.resolverVersion,
      run.contractVersion,
      run.contractHash,
      run.idempotencyKey,
      run.startedAt,
    ],
  );
}

export async function completeEvidenceRun(
  client: Queryable,
  runId: string,
  counts: EvidenceStateCounts & { readonly signalCount: number; readonly suggestionCount: number },
  completedAt: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE evidence_runs
        SET status = 'completed', incident_count = $2, signal_count = $3, suggestion_count = $4,
            reported_only_count = $5, onchain_observed_count = $6, corroborated_count = $7,
            contradicted_count = $8, completed_at = $9::timestamptz
      WHERE id = $1 AND status = 'running'`,
    [
      runId,
      counts.total,
      counts.signalCount,
      counts.suggestionCount,
      counts.reportedOnly,
      counts.onchainObserved,
      counts.corroborated,
      counts.contradicted,
      completedAt,
    ],
  );
  if (result.rowCount !== 1) {
    throw new DatabaseError('query', 'evidence run was not in a completable state', {
      details: { runId },
    });
  }
}

const EVIDENCE_RUN_COLUMNS = `id, clustering_run_id, batch_id, signal_run_id, data_origin,
  resolver_version, contract_version, contract_hash, idempotency_key, status, incident_count,
  signal_count, suggestion_count, reported_only_count, onchain_observed_count,
  corroborated_count, contradicted_count, to_json(started_at) #>> '{}' AS started_at,
  to_json(completed_at) #>> '{}' AS completed_at`;

interface EvidenceRunRow {
  id: string;
  clustering_run_id: string;
  batch_id: string;
  signal_run_id: string;
  data_origin: DataOrigin;
  resolver_version: string;
  contract_version: string;
  contract_hash: string;
  idempotency_key: string;
  status: 'running' | 'completed';
  incident_count: number;
  signal_count: number;
  suggestion_count: number;
  reported_only_count: number;
  onchain_observed_count: number;
  corroborated_count: number;
  contradicted_count: number;
  started_at: string;
  completed_at: string | null;
}

function toEvidenceRun(row: EvidenceRunRow): EvidenceRunRecord {
  return {
    id: row.id,
    clusteringRunId: row.clustering_run_id,
    batchId: row.batch_id,
    signalRunId: row.signal_run_id,
    dataOrigin: row.data_origin,
    resolverVersion: row.resolver_version,
    contractVersion: row.contract_version,
    contractHash: row.contract_hash,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    incidentCount: row.incident_count,
    signalCount: row.signal_count,
    suggestionCount: row.suggestion_count,
    reportedOnlyCount: row.reported_only_count,
    onchainObservedCount: row.onchain_observed_count,
    corroboratedCount: row.corroborated_count,
    contradictedCount: row.contradicted_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function getEvidenceRun(
  client: Queryable,
  id: string,
): Promise<EvidenceRunRecord | null> {
  const result = await client.query<EvidenceRunRow>(
    `SELECT ${EVIDENCE_RUN_COLUMNS} FROM evidence_runs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : toEvidenceRun(row);
}

export async function findEvidenceRunByIdempotencyKey(
  client: Queryable,
  idempotencyKey: string,
): Promise<EvidenceRunRecord | null> {
  const result = await client.query<EvidenceRunRow>(
    `SELECT ${EVIDENCE_RUN_COLUMNS} FROM evidence_runs WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const row = result.rows[0];
  return row === undefined ? null : toEvidenceRun(row);
}

// ------------------------------------------------------------------- subjects

export async function insertIncidentSubject(
  client: Queryable,
  subject: NewIncidentSubject,
): Promise<void> {
  await client.query(
    `INSERT INTO incident_subjects (
       id, clustering_run_id, batch_id, incident_cluster_id, chain, protocol_slug, actor,
       reason_code, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
    [
      subject.id,
      subject.clusteringRunId,
      subject.batchId,
      subject.incidentClusterId,
      subject.chain,
      subject.protocolSlug,
      subject.actor,
      subject.reasonCode,
      subject.createdAt,
    ],
  );
}

export type IncidentSubjectRecord = NewIncidentSubject;

/** The subject recorded for one incident of one clustering run, if any. */
export async function getIncidentSubject(
  client: Queryable,
  clusteringRunId: string,
  incidentClusterId: string,
): Promise<IncidentSubjectRecord | null> {
  const result = await client.query<{
    id: string;
    clustering_run_id: string;
    batch_id: string;
    incident_cluster_id: string;
    chain: ChainId;
    protocol_slug: string;
    actor: string;
    reason_code: string;
    created_at: string;
  }>(
    `SELECT id, clustering_run_id, batch_id, incident_cluster_id, chain, protocol_slug,
            actor, reason_code, to_json(created_at) #>> '{}' AS created_at
       FROM incident_subjects
      WHERE clustering_run_id = $1 AND incident_cluster_id = $2`,
    [clusteringRunId, incidentClusterId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        id: row.id,
        clusteringRunId: row.clustering_run_id,
        batchId: row.batch_id,
        incidentClusterId: row.incident_cluster_id,
        chain: row.chain,
        protocolSlug: row.protocol_slug,
        actor: row.actor,
        reasonCode: row.reason_code,
        createdAt: row.created_at,
      };
}

/**
 * Every incident of one clustering run, with its recorded subject when it has
 * one and its earliest reported instant. This is exactly the shape the pure
 * correlator consumes: identifiers, an explicit chain and protocol, and a
 * timestamp. No title, summary, body or URL is selected.
 */
export async function listIncidentSubjects(
  client: Queryable,
  clusteringRunId: string,
  limit: number,
): Promise<
  {
    readonly incidentId: string;
    readonly clusteringRunId: string;
    readonly batchId: string;
    readonly chain: ChainId | null;
    readonly protocolSlug: string | null;
    readonly earliestReportedAt: string | null;
  }[]
> {
  if (limit < 1 || limit > 100000) {
    throw new DatabaseError('query', 'incident page size outside the permitted range');
  }
  const result = await client.query<{
    incident_id: string;
    clustering_run_id: string;
    batch_id: string;
    chain: ChainId | null;
    protocol_slug: string | null;
    earliest_reported_at: string | null;
  }>(
    `SELECT c.id AS incident_id, c.clustering_run_id, c.batch_id,
            s.chain, s.protocol_slug,
            to_json(MIN(r.posted_at)) #>> '{}' AS earliest_reported_at
       FROM incident_clusters c
       LEFT JOIN incident_subjects s
              ON s.incident_cluster_id = c.id AND s.clustering_run_id = c.clustering_run_id
       LEFT JOIN incident_memberships m
              ON m.incident_cluster_id = c.id AND m.clustering_run_id = c.clustering_run_id
       LEFT JOIN source_rows r ON r.id = m.source_row_id
      WHERE c.clustering_run_id = $1
      GROUP BY c.id, c.clustering_run_id, c.batch_id, s.chain, s.protocol_slug
      ORDER BY c.id
      LIMIT $2`,
    [clusteringRunId, limit],
  );
  return result.rows.map((row) => ({
    incidentId: row.incident_id,
    clusteringRunId: row.clustering_run_id,
    batchId: row.batch_id,
    chain: row.chain,
    protocolSlug: row.protocol_slug,
    earliestReportedAt: row.earliest_reported_at,
  }));
}

// --------------------------------------------------------------- associations

export async function insertAssociations(
  client: Queryable,
  associations: readonly NewAssociation[],
): Promise<void> {
  for (const association of associations) {
    await client.query(
      `INSERT INTO incident_signal_associations (
         id, evidence_run_id, clustering_run_id, batch_id, signal_run_id, incident_cluster_id,
         signal_id, chain, claim_id, relation, status, reason_codes, offset_seconds, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'suggested', $11::jsonb, $12,
                 $13::timestamptz)`,
      [
        association.id,
        association.evidenceRunId,
        association.clusteringRunId,
        association.batchId,
        association.signalRunId,
        association.incidentClusterId,
        association.signalId,
        association.chain,
        association.claimId,
        association.relation,
        JSON.stringify(association.reasonCodes),
        association.offsetSeconds,
        association.createdAt,
      ],
    );
  }
}

export async function insertEvidenceStates(
  client: Queryable,
  states: readonly NewEvidenceState[],
): Promise<void> {
  for (const state of states) {
    await client.query(
      `INSERT INTO incident_evidence_states (
         id, evidence_run_id, clustering_run_id, batch_id, signal_run_id, incident_cluster_id,
         state, reason_code, claim_id, accepted_association_count, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
      [
        state.id,
        state.evidenceRunId,
        state.clusteringRunId,
        state.batchId,
        state.signalRunId,
        state.incidentClusterId,
        state.state,
        state.reasonCode,
        state.claimId,
        state.acceptedAssociationCount,
        state.createdAt,
      ],
    );
  }
}

/** Count-only state distribution for one evidence run. */
export async function countEvidenceStates(
  client: Queryable,
  evidenceRunId: string,
): Promise<EvidenceStateCounts> {
  const result = await client.query<{
    total: string;
    reported_only: string;
    onchain_observed: string;
    corroborated: string;
    contradicted: string;
  }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE state = 'reported_only')::text AS reported_only,
            count(*) FILTER (WHERE state = 'onchain_observed')::text AS onchain_observed,
            count(*) FILTER (WHERE state = 'corroborated')::text AS corroborated,
            count(*) FILTER (WHERE state = 'contradicted')::text AS contradicted
       FROM incident_evidence_states WHERE evidence_run_id = $1`,
    [evidenceRunId],
  );
  const row = result.rows[0];
  return {
    total: Number(row?.total ?? '0'),
    reportedOnly: Number(row?.reported_only ?? '0'),
    onchainObserved: Number(row?.onchain_observed ?? '0'),
    corroborated: Number(row?.corroborated ?? '0'),
    contradicted: Number(row?.contradicted ?? '0'),
  };
}

/** Count-only association distribution, by effective status. */
export async function countAssociations(
  client: Queryable,
  evidenceRunId: string,
): Promise<{ readonly suggested: number; readonly accepted: number; readonly rejected: number }> {
  const result = await client.query<{ status: string; count: string }>(
    `SELECT effective.status, count(*)::text AS count FROM (
       SELECT a.id,
              coalesce((SELECT CASE WHEN r.operation = 'accept' THEN 'accepted' ELSE 'rejected' END
                          FROM evidence_review_actions r
                         WHERE r.association_id = a.id
                         ORDER BY r.resulting_revision DESC LIMIT 1), a.status) AS status
         FROM incident_signal_associations a
        WHERE a.evidence_run_id = $1
     ) effective GROUP BY effective.status`,
    [evidenceRunId],
  );
  const counts = { suggested: 0, accepted: 0, rejected: 0 };
  for (const row of result.rows) {
    if (row.status === 'accepted') counts.accepted = Number(row.count);
    else if (row.status === 'rejected') counts.rejected = Number(row.count);
    else counts.suggested = Number(row.count);
  }
  return counts;
}

/**
 * Associations with their effective status, for the resolver. Bounded, and
 * carrying identifiers and relations only.
 */
export async function listEffectiveAssociations(
  client: Queryable,
  evidenceRunId: string,
  limit: number,
): Promise<
  {
    readonly associationId: string;
    readonly incidentId: string;
    readonly signalId: string;
    readonly claimId: string | null;
    readonly relation: AssociationRelation;
    readonly status: AssociationStatus;
  }[]
> {
  if (limit < 1 || limit > 100000) {
    throw new DatabaseError('query', 'association page size outside the permitted range');
  }
  const result = await client.query<{
    id: string;
    incident_cluster_id: string;
    signal_id: string;
    claim_id: string | null;
    relation: AssociationRelation;
    status: AssociationStatus;
  }>(
    `SELECT a.id, a.incident_cluster_id, a.signal_id,
            coalesce(latest.claim_id, a.claim_id) AS claim_id,
            coalesce(latest.relation, a.relation) AS relation,
            coalesce(latest.status, a.status) AS status
       FROM incident_signal_associations a
       LEFT JOIN LATERAL (
         SELECT CASE WHEN r.operation = 'accept' THEN 'accepted' ELSE 'rejected' END AS status,
                r.relation, r.claim_id
           FROM evidence_review_actions r
          WHERE r.association_id = a.id
          ORDER BY r.resulting_revision DESC LIMIT 1
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
    claimId: row.claim_id,
    relation: row.relation,
    status: row.status,
  }));
}

// ------------------------------------------------------------ review actions

export async function insertEvidenceAction(
  client: Queryable,
  action: NewEvidenceAction,
): Promise<void> {
  await client.query(
    `INSERT INTO evidence_review_actions (
       id, evidence_run_id, association_id, operation, relation, claim_id, reason_code,
       rationale, actor, prior_revision, resulting_revision, idempotency_key, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz)`,
    [
      action.id,
      action.evidenceRunId,
      action.associationId,
      action.operation,
      action.relation,
      action.claimId,
      action.reasonCode,
      action.rationale,
      action.actor,
      action.priorRevision,
      action.priorRevision + 1,
      action.idempotencyKey,
      action.createdAt,
    ],
  );
}

const ACTION_COLUMNS = `id, evidence_run_id, association_id, operation, relation, claim_id,
  reason_code, rationale, actor, prior_revision, resulting_revision, idempotency_key,
  to_json(created_at) #>> '{}' AS created_at`;

interface ActionRow {
  id: string;
  evidence_run_id: string;
  association_id: string;
  operation: 'accept' | 'reject';
  relation: AssociationRelation;
  claim_id: string | null;
  reason_code: string;
  rationale: string | null;
  actor: string;
  prior_revision: number;
  resulting_revision: number;
  idempotency_key: string;
  created_at: string;
}

function toAction(row: ActionRow): EvidenceActionRecord {
  return {
    id: row.id,
    evidenceRunId: row.evidence_run_id,
    associationId: row.association_id,
    operation: row.operation,
    relation: row.relation,
    claimId: row.claim_id,
    reasonCode: row.reason_code,
    rationale: row.rationale,
    actor: row.actor,
    priorRevision: row.prior_revision,
    resultingRevision: row.resulting_revision,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

export async function currentEvidenceRevision(
  client: Queryable,
  evidenceRunId: string,
): Promise<number> {
  const result = await client.query<{ revision: string }>(
    `SELECT coalesce(max(resulting_revision), 0)::text AS revision
       FROM evidence_review_actions WHERE evidence_run_id = $1`,
    [evidenceRunId],
  );
  return Number(result.rows[0]?.revision ?? '0');
}

export async function findEvidenceActionByIdempotencyKey(
  client: Queryable,
  evidenceRunId: string,
  idempotencyKey: string,
): Promise<EvidenceActionRecord | null> {
  const result = await client.query<ActionRow>(
    `SELECT ${ACTION_COLUMNS} FROM evidence_review_actions
      WHERE evidence_run_id = $1 AND idempotency_key = $2`,
    [evidenceRunId, idempotencyKey],
  );
  const row = result.rows[0];
  return row === undefined ? null : toAction(row);
}

export async function listEvidenceActions(
  client: Queryable,
  evidenceRunId: string,
): Promise<EvidenceActionRecord[]> {
  const result = await client.query<ActionRow>(
    `SELECT ${ACTION_COLUMNS} FROM evidence_review_actions
      WHERE evidence_run_id = $1 ORDER BY resulting_revision`,
    [evidenceRunId],
  );
  return result.rows.map(toAction);
}

/**
 * Count-only reporting figures for one explicit window of one batch.
 *
 * The window is the caller's: two instants, both supplied. Nothing here infers
 * an editorial week, because decision D10 has not fixed one, and no weekly
 * candidate decision is read.
 */
export async function countReportingWindow(
  client: Queryable,
  clusteringRunId: string,
  startsAt: string,
  endsAt: string,
): Promise<{
  readonly sourceStoryCount: number;
  readonly incidentCount: number;
  readonly multiSourceIncidentCount: number;
}> {
  const result = await client.query<{
    stories: string;
    incidents: string;
    multi_source: string;
  }>(
    `WITH windowed AS (
       SELECT m.incident_cluster_id, m.source_row_id
         FROM incident_memberships m
         JOIN source_rows r ON r.id = m.source_row_id
        WHERE m.clustering_run_id = $1
          AND r.posted_at >= $2::timestamptz AND r.posted_at < $3::timestamptz
     ), per_incident AS (
       SELECT incident_cluster_id, count(*) AS members FROM windowed GROUP BY incident_cluster_id
     )
     SELECT (SELECT count(*)::text FROM windowed) AS stories,
            (SELECT count(*)::text FROM per_incident) AS incidents,
            (SELECT count(*)::text FROM per_incident WHERE members > 1) AS multi_source`,
    [clusteringRunId, startsAt, endsAt],
  );
  const row = result.rows[0];
  return {
    sourceStoryCount: Number(row?.stories ?? '0'),
    incidentCount: Number(row?.incidents ?? '0'),
    multiSourceIncidentCount: Number(row?.multi_source ?? '0'),
  };
}

/** Every distinct signal target seen in one run, for the anomaly feed. */
export async function listSignalTargets(
  client: Queryable,
  signalRunId: string,
): Promise<
  { readonly chain: ChainId; readonly protocolSlug: string; readonly dataOrigin: DataOrigin }[]
> {
  const result = await client.query<{
    chain: ChainId;
    protocol_slug: string;
    data_origin: DataOrigin;
  }>(
    `SELECT DISTINCT chain, protocol_slug, data_origin FROM graph_signals
      WHERE signal_run_id = $1 ORDER BY chain, protocol_slug`,
    [signalRunId],
  );
  return result.rows.map((row) => ({
    chain: row.chain,
    protocolSlug: row.protocol_slug,
    dataOrigin: row.data_origin,
  }));
}

/**
 * Draft input for one evidence run: each incident with its resolved state and
 * the source rows behind it.
 *
 * This is the only query in the project that returns source text, and it
 * exists because a draft is made of text. It is never printed by a command:
 * the drafting path writes to an ignored directory and the command reports
 * counts. Nothing here returns a raw cell, a `ch` value or a review state.
 */
export async function listDraftIncidents(
  client: Queryable,
  evidenceRunId: string,
  limit: number,
): Promise<
  {
    readonly incidentId: string;
    readonly clusteringRunId: string;
    readonly batchId: string;
    readonly dataOrigin: DataOrigin;
    readonly state: string;
    readonly claimId: string | null;
    readonly acceptedAssociationCount: number;
    readonly hasSubject: boolean;
    readonly sources: readonly {
      readonly sourceRowId: string;
      readonly title: string | null;
      readonly publisher: string | null;
      readonly url: string | null;
      readonly postedAt: string | null;
    }[];
  }[]
> {
  if (limit < 1 || limit > 5000) {
    throw new DatabaseError('query', 'draft page size outside the permitted range');
  }
  const result = await client.query<{
    incident_id: string;
    clustering_run_id: string;
    batch_id: string;
    data_origin: DataOrigin;
    state: string;
    claim_id: string | null;
    accepted_association_count: number;
    has_subject: boolean;
    sources: {
      sourceRowId: string;
      title: string | null;
      publisher: string | null;
      url: string | null;
      postedAt: string | null;
    }[];
  }>(
    `SELECT s.incident_cluster_id AS incident_id, s.clustering_run_id, s.batch_id,
            r.data_origin, s.state, s.claim_id, s.accepted_association_count,
            (sub.id IS NOT NULL) AS has_subject,
            coalesce(
              (SELECT jsonb_agg(jsonb_build_object(
                        'sourceRowId', sr.id,
                        'title', sr.normalized_title,
                        'publisher', sr.raw_category,
                        'url', sr.canonical_url,
                        'postedAt', to_json(sr.posted_at) #>> '{}')
                       ORDER BY sr.id)
                 FROM incident_memberships m
                 JOIN source_rows sr ON sr.id = m.source_row_id
                WHERE m.incident_cluster_id = s.incident_cluster_id
                  AND m.clustering_run_id = s.clustering_run_id),
              '[]'::jsonb) AS sources
       FROM incident_evidence_states s
       JOIN evidence_runs r ON r.id = s.evidence_run_id
       LEFT JOIN incident_subjects sub
              ON sub.incident_cluster_id = s.incident_cluster_id
             AND sub.clustering_run_id = s.clustering_run_id
      WHERE s.evidence_run_id = $1
      ORDER BY s.incident_cluster_id
      LIMIT $2`,
    [evidenceRunId, limit],
  );
  return result.rows.map((row) => ({
    incidentId: row.incident_id,
    clusteringRunId: row.clustering_run_id,
    batchId: row.batch_id,
    dataOrigin: row.data_origin,
    state: row.state,
    claimId: row.claim_id,
    acceptedAssociationCount: row.accepted_association_count,
    hasSubject: row.has_subject,
    sources: row.sources,
  }));
}
