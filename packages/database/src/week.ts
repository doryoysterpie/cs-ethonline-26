import type { DataOrigin } from '@cas/contracts';

import type { Queryable } from './database.js';
import { DatabaseError } from './errors.js';

/**
 * The editorial week (CAS-003, migration 0014): the run manifest, its child
 * runs, the owner's per-incident selections with their provenance, and the
 * sift-table read. Every write is append-only or a single recorded
 * transition; every read is bounded.
 */

export type WeekRunStatus = 'running' | 'completed' | 'failed';
export type WeekChildKind = 'import' | 'classification' | 'clustering';
export type WeekChildOutcome = 'created' | 'reused' | 'provided' | 'failed';
export type SelectionState = 'selected' | 'unselected';

export interface NewWeekRun {
  readonly id: string;
  readonly dataOrigin: DataOrigin;
  readonly batchId: string;
  readonly timeZone: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly publicationCutoffAt: string;
  readonly categories: readonly string[];
  readonly idempotencyKey: string;
  readonly startedAt: string;
}

export interface WeekRunRecord extends NewWeekRun {
  readonly freezeAt: string;
  readonly status: WeekRunStatus;
  readonly failureCode: string | null;
  readonly completedAt: string | null;
}

export interface NewWeekRunChild {
  readonly id: string;
  readonly weekRunId: string;
  readonly position: number;
  readonly kind: WeekChildKind;
  readonly category: string | null;
  readonly batchId: string | null;
  readonly classificationRunId: string | null;
  readonly clusteringRunId: string | null;
  readonly outcome: WeekChildOutcome;
  readonly errorCode: string | null;
  readonly createdAt: string;
}

export type WeekRunChildRecord = NewWeekRunChild;

export interface NewIssueSelection {
  readonly id: string;
  readonly weekRunId: string;
  readonly batchId: string;
  readonly clusteringRunId: string;
  readonly incidentId: string;
  readonly category: string;
  readonly state: SelectionState;
  readonly revision: number;
  readonly actorAccountId: string;
  readonly note: string | null;
  readonly createdAt: string;
}

export type IssueSelectionRecord = NewIssueSelection;

export interface IssueSelectionMemberRef {
  readonly membershipId: string;
  readonly sourceRowId: string;
  readonly batchId: string;
  readonly rowHash: string;
}

export interface WeekIncidentRow {
  readonly incidentId: string;
  readonly kind: string;
  readonly memberCount: number;
  readonly reasonCodes: readonly string[];
  readonly inWindow: boolean;
  readonly carried: boolean;
  readonly postedFrom: string | null;
  readonly postedTo: string | null;
  /** The representative row's normalized title, or null when text was not requested. */
  readonly title: string | null;
}

export type WeekIncidentSort = 'posted_desc' | 'members_desc';

const WEEK_RUN_COLUMNS = `id, data_origin, batch_id, time_zone,
  to_json(window_start) #>> '{}' AS window_start,
  to_json(window_end) #>> '{}' AS window_end,
  to_json(freeze_at) #>> '{}' AS freeze_at,
  to_json(publication_cutoff_at) #>> '{}' AS publication_cutoff_at,
  categories, idempotency_key, status, failure_code,
  to_json(started_at) #>> '{}' AS started_at,
  to_json(completed_at) #>> '{}' AS completed_at`;

interface WeekRunRow {
  id: string;
  data_origin: DataOrigin;
  batch_id: string;
  time_zone: string;
  window_start: string;
  window_end: string;
  freeze_at: string;
  publication_cutoff_at: string;
  categories: string[];
  idempotency_key: string;
  status: WeekRunStatus;
  failure_code: string | null;
  started_at: string;
  completed_at: string | null;
}

function toWeekRun(row: WeekRunRow): WeekRunRecord {
  return {
    id: row.id,
    dataOrigin: row.data_origin,
    batchId: row.batch_id,
    timeZone: row.time_zone,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    freezeAt: row.freeze_at,
    publicationCutoffAt: row.publication_cutoff_at,
    categories: row.categories,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    failureCode: row.failure_code,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function insertRunningWeekRun(client: Queryable, run: NewWeekRun): Promise<void> {
  await client.query(
    `INSERT INTO week_runs (id, data_origin, batch_id, time_zone, window_start, window_end, freeze_at,
       publication_cutoff_at, categories, idempotency_key, status, failure_code, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $6::timestamptz, $7::timestamptz,
             $8::jsonb, $9, 'running', NULL, $10::timestamptz, NULL)`,
    [
      run.id,
      run.dataOrigin,
      run.batchId,
      run.timeZone,
      run.windowStart,
      run.windowEnd,
      run.publicationCutoffAt,
      JSON.stringify(run.categories),
      run.idempotencyKey,
      run.startedAt,
    ],
  );
}

/** The one permitted transition. Returns false when the run was not running. */
export async function completeWeekRun(
  client: Queryable,
  id: string,
  status: 'completed' | 'failed',
  completedAt: string,
  failureCode: string | null,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE week_runs SET status = $2, completed_at = $3::timestamptz, failure_code = $4
      WHERE id = $1 AND status = 'running'`,
    [id, status, completedAt, failureCode],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function getWeekRun(client: Queryable, id: string): Promise<WeekRunRecord | null> {
  const result = await client.query<WeekRunRow>(
    `SELECT ${WEEK_RUN_COLUMNS} FROM week_runs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : toWeekRun(row);
}

export async function findCompletedWeekRunByKey(
  client: Queryable,
  idempotencyKey: string,
): Promise<WeekRunRecord | null> {
  const result = await client.query<WeekRunRow>(
    `SELECT ${WEEK_RUN_COLUMNS} FROM week_runs WHERE idempotency_key = $1 AND status = 'completed'`,
    [idempotencyKey],
  );
  const row = result.rows[0];
  return row === undefined ? null : toWeekRun(row);
}

export async function listWeekRuns(client: Queryable, limit: number): Promise<WeekRunRecord[]> {
  if (limit < 1 || limit > 500) throw new DatabaseError('query', 'week run page size out of range');
  const result = await client.query<WeekRunRow>(
    `SELECT ${WEEK_RUN_COLUMNS} FROM week_runs ORDER BY window_end DESC, started_at DESC, id LIMIT $1`,
    [limit],
  );
  return result.rows.map(toWeekRun);
}

export async function insertWeekRunChild(client: Queryable, child: NewWeekRunChild): Promise<void> {
  await client.query(
    `INSERT INTO week_run_children (id, week_run_id, position, kind, category, batch_id,
       classification_run_id, clustering_run_id, outcome, error_code, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
    [
      child.id,
      child.weekRunId,
      child.position,
      child.kind,
      child.category,
      child.batchId,
      child.classificationRunId,
      child.clusteringRunId,
      child.outcome,
      child.errorCode,
      child.createdAt,
    ],
  );
}

export async function listWeekRunChildren(
  client: Queryable,
  weekRunId: string,
): Promise<WeekRunChildRecord[]> {
  const result = await client.query<{
    id: string;
    week_run_id: string;
    position: number;
    kind: WeekChildKind;
    category: string | null;
    batch_id: string | null;
    classification_run_id: string | null;
    clustering_run_id: string | null;
    outcome: WeekChildOutcome;
    error_code: string | null;
    created_at: string;
  }>(
    `SELECT id, week_run_id, position, kind, category, batch_id, classification_run_id,
            clustering_run_id, outcome, error_code, to_json(created_at) #>> '{}' AS created_at
       FROM week_run_children WHERE week_run_id = $1 ORDER BY position`,
    [weekRunId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    weekRunId: row.week_run_id,
    position: row.position,
    kind: row.kind,
    category: row.category,
    batchId: row.batch_id,
    classificationRunId: row.classification_run_id,
    clusteringRunId: row.clustering_run_id,
    outcome: row.outcome,
    errorCode: row.error_code,
    createdAt: row.created_at,
  }));
}

/** The incident's member rows as references, the provenance a selection carries. */
export async function listIncidentMemberRefs(
  client: Queryable,
  clusteringRunId: string,
  incidentId: string,
): Promise<IssueSelectionMemberRef[]> {
  const result = await client.query<{
    id: string;
    source_row_id: string;
    batch_id: string;
    row_hash: string;
  }>(
    `SELECT id, source_row_id, batch_id, row_hash FROM incident_memberships
      WHERE clustering_run_id = $1 AND incident_cluster_id = $2 ORDER BY source_row_id`,
    [clusteringRunId, incidentId],
  );
  return result.rows.map((row) => ({
    membershipId: row.id,
    sourceRowId: row.source_row_id,
    batchId: row.batch_id,
    rowHash: row.row_hash,
  }));
}

/** The last revision recorded for the incident in this week, 0 when none. */
export async function lastSelectionRevision(
  client: Queryable,
  weekRunId: string,
  incidentId: string,
): Promise<number> {
  const result = await client.query<{ revision: number | null }>(
    `SELECT max(revision) AS revision FROM issue_selections WHERE week_run_id = $1 AND incident_id = $2`,
    [weekRunId, incidentId],
  );
  return result.rows[0]?.revision ?? 0;
}

/** Appends one selection record and its member references; the guard checks the revision. */
export async function insertIssueSelection(
  client: Queryable,
  selection: NewIssueSelection,
  members: readonly IssueSelectionMemberRef[],
): Promise<void> {
  if (members.length === 0 || members.length > 10_000) {
    throw new DatabaseError('query', 'issue selection member count out of range');
  }
  await client.query(
    `INSERT INTO issue_selections (id, week_run_id, batch_id, clustering_run_id, incident_id, category,
       state, revision, actor_account_id, note, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
    [
      selection.id,
      selection.weekRunId,
      selection.batchId,
      selection.clusteringRunId,
      selection.incidentId,
      selection.category,
      selection.state,
      selection.revision,
      selection.actorAccountId,
      selection.note,
      selection.createdAt,
    ],
  );
  for (const member of members) {
    await client.query(
      `INSERT INTO issue_selection_members (selection_id, incident_id, clustering_run_id, membership_id, source_row_id, batch_id, row_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        selection.id,
        selection.incidentId,
        selection.clusteringRunId,
        member.membershipId,
        member.sourceRowId,
        member.batchId,
        member.rowHash,
      ],
    );
  }
}

/** The latest revision per incident for one week run, keyed by incident. */
export async function listLatestIssueSelections(
  client: Queryable,
  weekRunId: string,
): Promise<Map<string, IssueSelectionRecord>> {
  const result = await client.query<{
    id: string;
    week_run_id: string;
    batch_id: string;
    clustering_run_id: string;
    incident_id: string;
    category: string;
    state: SelectionState;
    revision: number;
    actor_account_id: string;
    note: string | null;
    created_at: string;
  }>(
    `SELECT DISTINCT ON (incident_id) id, week_run_id, batch_id, clustering_run_id, incident_id, category,
            state, revision, actor_account_id, note, to_json(created_at) #>> '{}' AS created_at
       FROM issue_selections WHERE week_run_id = $1 ORDER BY incident_id, revision DESC`,
    [weekRunId],
  );
  const latest = new Map<string, IssueSelectionRecord>();
  for (const row of result.rows) {
    latest.set(row.incident_id, {
      id: row.id,
      weekRunId: row.week_run_id,
      batchId: row.batch_id,
      clusteringRunId: row.clustering_run_id,
      incidentId: row.incident_id,
      category: row.category,
      state: row.state,
      revision: row.revision,
      actorAccountId: row.actor_account_id,
      note: row.note,
      createdAt: row.created_at,
    });
  }
  return latest;
}

/**
 * The carried incidents a round-up must flag (re-review of 22 October 2026,
 * RR4): every incident of the run that is carried and not in the window,
 * whose latest selection for the week and category is neither `selected` nor
 * an `unselected` with a note (those are the omitted entries), in the sift
 * table's posted order. Not a page of the sift table: the caller passes its
 * bound plus one and refuses a full result, so nothing is dropped silently.
 */
export async function listCarriedIncidents(
  client: Queryable,
  input: {
    readonly clusteringRunId: string;
    readonly weekRunId: string;
    readonly category: string;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly limit: number;
  },
): Promise<{ readonly incidentId: string; readonly title: string }[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20_000) {
    throw new DatabaseError('query', 'carried page size out of range');
  }
  const result = await client.query<{ incident_id: string; title: string | null }>(
    `WITH members AS (
       SELECT m.incident_cluster_id AS incident_id, s.posted_at, s.row_hash
         FROM incident_memberships m
         JOIN source_rows s ON s.id = m.source_row_id AND s.batch_id = m.batch_id
        WHERE m.clustering_run_id = $1
     ), first_seen AS (
       SELECT s.row_hash, min(coalesce(r.read_completed_at, b.completed_at)) AS first_seen_at
         FROM source_rows s
         JOIN import_batches b ON b.id = s.batch_id
         LEFT JOIN sheets_import_reads r ON r.batch_id = b.id
        WHERE s.row_hash IN (SELECT row_hash FROM members)
        GROUP BY s.row_hash
     ), per_incident AS (
       SELECT mm.incident_id,
              bool_or(mm.posted_at > $2::timestamptz AND mm.posted_at <= $3::timestamptz
                      AND fs.first_seen_at <= $3::timestamptz) AS in_window,
              bool_or(mm.posted_at <= $2::timestamptz
                      AND fs.first_seen_at > $2::timestamptz AND fs.first_seen_at <= $3::timestamptz) AS carried,
              max(mm.posted_at) AS posted_to
         FROM members mm JOIN first_seen fs ON fs.row_hash = mm.row_hash
        GROUP BY mm.incident_id
     ), latest AS (
       SELECT DISTINCT ON (incident_id) incident_id, state, note
         FROM issue_selections WHERE week_run_id = $4 AND category = $5
        ORDER BY incident_id, revision DESC
     )
     SELECT c.id AS incident_id, rs.normalized_title AS title
       FROM incident_clusters c
       JOIN per_incident p ON p.incident_id = c.id
       JOIN source_rows rs ON rs.id = c.representative_source_row_id
       LEFT JOIN latest l ON l.incident_id = c.id
      WHERE c.clustering_run_id = $1
        AND p.carried AND NOT p.in_window
        AND (l.state IS NULL OR l.state <> 'selected')
        AND NOT (l.state = 'unselected' AND l.note IS NOT NULL)
      ORDER BY p.posted_to DESC NULLS LAST, c.member_count DESC, c.id
      LIMIT $6`,
    [
      input.clusteringRunId,
      input.windowStart,
      input.windowEnd,
      input.weekRunId,
      input.category,
      input.limit,
    ],
  );
  return result.rows.map((row) => ({ incidentId: row.incident_id, title: row.title ?? '' }));
}

/**
 * The sift table for one clustering run and one window (D10 resolution).
 * An incident is in the week when a member row was posted inside the window
 * and first seen by the freeze; it is carried only when no member qualifies
 * for the window and one posted before it was first seen inside it, so the
 * two flags never hold together (review of 22 October 2026, F6). First
 * seen is the completion of the earliest import read holding the row's hash,
 * or the batch's completion for a batch without a Sheets read. A row with no
 * posted time belongs to no week. Text is selected only when asked for, and
 * only the representative row's title; search is a bounded substring match.
 */
export async function listWeekIncidents(
  client: Queryable,
  input: {
    readonly clusteringRunId: string;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly withText: boolean;
    readonly search: string | null;
    readonly sort: WeekIncidentSort;
    readonly limit: number;
  },
): Promise<WeekIncidentRow[]> {
  if (input.limit < 1 || input.limit > 1000) {
    throw new DatabaseError('query', 'week table page size out of range');
  }
  if (input.search !== null && (input.search.length === 0 || input.search.length > 200)) {
    throw new DatabaseError('query', 'week table search length out of range');
  }
  // A search over titles is a read of titles: without text, no search. The
  // data-access layer refuses earlier with a fixed code; this is the floor
  // (review of 22 October 2026, F1).
  if (!input.withText && input.search !== null) {
    throw new DatabaseError('query', 'a title search needs the text it searches');
  }
  const order =
    input.sort === 'members_desc'
      ? 'c.member_count DESC, p.posted_to DESC NULLS LAST, c.id'
      : 'p.posted_to DESC NULLS LAST, c.member_count DESC, c.id';
  const result = await client.query<{
    incident_id: string;
    kind: string;
    member_count: number;
    reason_codes: string[];
    in_window: boolean;
    carried: boolean;
    posted_from: string | null;
    posted_to: string | null;
    title: string | null;
  }>(
    `WITH members AS (
       SELECT m.incident_cluster_id AS incident_id, s.posted_at, s.row_hash
         FROM incident_memberships m
         JOIN source_rows s ON s.id = m.source_row_id AND s.batch_id = m.batch_id
        WHERE m.clustering_run_id = $1
     ), first_seen AS (
       SELECT s.row_hash, min(coalesce(r.read_completed_at, b.completed_at)) AS first_seen_at
         FROM source_rows s
         JOIN import_batches b ON b.id = s.batch_id
         LEFT JOIN sheets_import_reads r ON r.batch_id = b.id
        WHERE s.row_hash IN (SELECT row_hash FROM members)
        GROUP BY s.row_hash
     ), per_incident AS (
       SELECT mm.incident_id,
              bool_or(mm.posted_at > $2::timestamptz AND mm.posted_at <= $3::timestamptz
                      AND fs.first_seen_at <= $3::timestamptz) AS in_window,
              bool_or(mm.posted_at <= $2::timestamptz
                      AND fs.first_seen_at > $2::timestamptz AND fs.first_seen_at <= $3::timestamptz) AS carried,
              min(mm.posted_at) AS posted_from,
              max(mm.posted_at) AS posted_to
         FROM members mm JOIN first_seen fs ON fs.row_hash = mm.row_hash
        GROUP BY mm.incident_id
     )
     SELECT c.id AS incident_id, c.kind, c.member_count, c.reason_codes,
            p.in_window, (p.carried AND NOT p.in_window) AS carried,
            to_json(p.posted_from) #>> '{}' AS posted_from,
            to_json(p.posted_to) #>> '{}' AS posted_to,
            CASE WHEN $4::boolean THEN rs.normalized_title ELSE NULL END AS title
       FROM incident_clusters c
       JOIN per_incident p ON p.incident_id = c.id
       JOIN source_rows rs ON rs.id = c.representative_source_row_id
      WHERE c.clustering_run_id = $1
        AND (p.in_window OR p.carried)
        AND ($5::text IS NULL OR rs.normalized_title ILIKE '%' || replace(replace(replace($5::text, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' ESCAPE '\\')
      ORDER BY ${order}
      LIMIT $6`,
    [
      input.clusteringRunId,
      input.windowStart,
      input.windowEnd,
      input.withText,
      input.search,
      input.limit,
    ],
  );
  return result.rows.map((row) => ({
    incidentId: row.incident_id,
    kind: row.kind,
    memberCount: row.member_count,
    reasonCodes: row.reason_codes,
    inWindow: row.in_window,
    carried: row.carried,
    postedFrom: row.posted_from,
    postedTo: row.posted_to,
    title: row.title,
  }));
}
