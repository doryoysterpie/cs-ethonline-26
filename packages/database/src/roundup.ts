import type { Queryable } from './database.js';
import { DatabaseError } from './errors.js';

/**
 * The round-up (CAS-004, migration 0015): revisions per week run and
 * category, the model ledger the monthly cap sums over, and the reads the
 * owner's editor needs. Append-only throughout.
 */

export type RoundupRevisionKind = 'deterministic' | 'generated' | 'edited';
export type ModelCallOutcome = 'completed' | 'refused' | 'failed';

export interface RoundupProvenanceColumns {
  readonly model: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly templateVersion: string;
  readonly templateHash: string;
  readonly inputDigest: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrodollars: number;
}

export interface NewRoundupRevision {
  readonly weekRunId: string;
  readonly category: string;
  readonly revision: number;
  readonly kind: RoundupRevisionKind;
  readonly slots: unknown;
  readonly markdown: string;
  readonly provenance: RoundupProvenanceColumns | null;
  readonly savedByAccountId: string;
  readonly createdAt: string;
}

export type RoundupRevisionRecord = NewRoundupRevision;

export type ModelCallKind = 'roundup' | 'article';

export interface NewModelCall {
  readonly id: string;
  readonly kind: ModelCallKind;
  readonly weekRunId: string | null;
  readonly category: string | null;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrodollars: number;
  readonly outcome: ModelCallOutcome;
  readonly code: string;
  readonly actorAccountId: string;
  readonly createdAt: string;
}

const REVISION_COLUMNS = `week_run_id, category, revision, kind, slots, markdown, model, prompt_version,
  prompt_hash, template_version, template_hash, input_digest, input_tokens, output_tokens,
  cost_microdollars::text AS cost_microdollars, saved_by_account_id,
  to_json(created_at) #>> '{}' AS created_at`;

interface RevisionRow {
  week_run_id: string;
  category: string;
  revision: number;
  kind: RoundupRevisionKind;
  slots: unknown;
  markdown: string;
  model: string | null;
  prompt_version: string | null;
  prompt_hash: string | null;
  template_version: string | null;
  template_hash: string | null;
  input_digest: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_microdollars: string | null;
  saved_by_account_id: string;
  created_at: string;
}

function toRevision(row: RevisionRow): RoundupRevisionRecord {
  const provenance =
    row.kind === 'generated' &&
    row.model !== null &&
    row.prompt_version !== null &&
    row.prompt_hash !== null &&
    row.template_version !== null &&
    row.template_hash !== null &&
    row.input_digest !== null &&
    row.input_tokens !== null &&
    row.output_tokens !== null &&
    row.cost_microdollars !== null
      ? {
          model: row.model,
          promptVersion: row.prompt_version,
          promptHash: row.prompt_hash,
          templateVersion: row.template_version,
          templateHash: row.template_hash,
          inputDigest: row.input_digest,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          costMicrodollars: Number(row.cost_microdollars),
        }
      : null;
  return {
    weekRunId: row.week_run_id,
    category: row.category,
    revision: row.revision,
    kind: row.kind,
    slots: row.slots,
    markdown: row.markdown,
    provenance,
    savedByAccountId: row.saved_by_account_id,
    createdAt: row.created_at,
  };
}

export async function insertRoundupRevision(
  client: Queryable,
  revision: NewRoundupRevision,
): Promise<void> {
  const p = revision.provenance;
  await client.query(
    `INSERT INTO roundup_revisions (week_run_id, category, revision, kind, slots, markdown, model,
       prompt_version, prompt_hash, template_version, template_hash, input_digest, input_tokens,
       output_tokens, cost_microdollars, saved_by_account_id, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::timestamptz)`,
    [
      revision.weekRunId,
      revision.category,
      revision.revision,
      revision.kind,
      JSON.stringify(revision.slots),
      revision.markdown,
      p?.model ?? null,
      p?.promptVersion ?? null,
      p?.promptHash ?? null,
      p?.templateVersion ?? null,
      p?.templateHash ?? null,
      p?.inputDigest ?? null,
      p?.inputTokens ?? null,
      p?.outputTokens ?? null,
      p?.costMicrodollars ?? null,
      revision.savedByAccountId,
      revision.createdAt,
    ],
  );
}

export async function listRoundupRevisions(
  client: Queryable,
  weekRunId: string,
  category: string,
): Promise<RoundupRevisionRecord[]> {
  const result = await client.query<RevisionRow>(
    `SELECT ${REVISION_COLUMNS} FROM roundup_revisions
      WHERE week_run_id = $1 AND category = $2 ORDER BY revision`,
    [weekRunId, category],
  );
  return result.rows.map(toRevision);
}

export async function latestRoundupRevision(
  client: Queryable,
  weekRunId: string,
  category: string,
): Promise<RoundupRevisionRecord | null> {
  const result = await client.query<RevisionRow>(
    `SELECT ${REVISION_COLUMNS} FROM roundup_revisions
      WHERE week_run_id = $1 AND category = $2 ORDER BY revision DESC LIMIT 1`,
    [weekRunId, category],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRevision(row);
}

export async function insertModelCall(client: Queryable, call: NewModelCall): Promise<void> {
  await client.query(
    `INSERT INTO model_calls (id, kind, week_run_id, category, model, input_tokens, output_tokens,
       cost_microdollars, outcome, code, actor_account_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)`,
    [
      call.id,
      call.kind,
      call.weekRunId,
      call.category,
      call.model,
      call.inputTokens,
      call.outputTokens,
      call.costMicrodollars,
      call.outcome,
      call.code,
      call.actorAccountId,
      call.createdAt,
    ],
  );
}

/**

 * The month's spend in microdollars for one kind of call: every call of that
 * kind between the two instants, whatever its outcome. A request the model
 * answered is billed whether or not the answer was kept (review of pull
 * request 24, F3); a refusal before any request carries zero and adds
 * nothing. Each output has its own cap (D9 resolution for the article,
 * option b), so the sum is never across kinds.
 */
export async function spendBetween(
  client: Queryable,
  kind: ModelCallKind,
  from: string,
  to: string,
): Promise<number> {
  if (
    Number.isNaN(Date.parse(from)) ||
    Number.isNaN(Date.parse(to)) ||
    Date.parse(to) <= Date.parse(from)
  ) {
    throw new DatabaseError('query', 'spend window out of range');
  }
  const result = await client.query<{ spent: string }>(
    `SELECT coalesce(sum(cost_microdollars), 0)::text AS spent FROM model_calls
      WHERE kind = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
    [kind, from, to],
  );
  return Number(result.rows[0]?.spent ?? '0');
}

/**
 * The selection's rows for one week run and one category, in selection
 * order (the latest `selected` record's time), each incident with its member
 * rows in row order: the recorded fields the round-up reformats and nothing
 * else. Titles and summaries are stored text and travel to the owner's own
 * generation only.
 */
export interface SelectedRowRecord {
  readonly incidentId: string;
  readonly selectedAt: string;
  readonly sourceRowId: string;
  readonly rowNumber: number;
  readonly title: string;
  readonly summary: string | null;
  readonly url: string;
  readonly postedAt: string | null;
}

/** The most rows one call may ask for; a caller asks for its bound plus one and refuses a full page (review F5). */
export const SELECTION_PAGE_MAX = 20_000;

export async function listSelectedRows(
  client: Queryable,
  weekRunId: string,
  category: string,
  limit: number,
): Promise<SelectedRowRecord[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > SELECTION_PAGE_MAX)
    throw new DatabaseError('query', 'selection page size out of range');
  const result = await client.query<{
    incident_id: string;
    selected_at: string;
    source_row_id: string;
    row_number: number;
    title: string | null;
    summary: string | null;
    url: string | null;
    posted_at: string | null;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (incident_id) incident_id, clustering_run_id, state, created_at
         FROM issue_selections WHERE week_run_id = $1 AND category = $2
        ORDER BY incident_id, revision DESC
     )
     SELECT l.incident_id, to_json(l.created_at) #>> '{}' AS selected_at,
            s.id AS source_row_id, s.row_number, s.normalized_title AS title,
            s.derived_summary_text AS summary, coalesce(s.canonical_url, s.raw_url) AS url,
            to_json(s.posted_at) #>> '{}' AS posted_at
       FROM latest l
       JOIN incident_memberships m ON m.incident_cluster_id = l.incident_id AND m.clustering_run_id = l.clustering_run_id
       JOIN source_rows s ON s.id = m.source_row_id AND s.batch_id = m.batch_id
      WHERE l.state = 'selected'
      ORDER BY l.created_at, l.incident_id, s.row_number
      LIMIT $3`,
    [weekRunId, category, limit],
  );
  return result.rows.map((row) => ({
    incidentId: row.incident_id,
    selectedAt: row.selected_at,
    sourceRowId: row.source_row_id,
    rowNumber: row.row_number,
    title: row.title ?? '',
    summary: row.summary,
    url: row.url ?? '',
    postedAt: row.posted_at,
  }));
}

/** The latest unselected-with-a-note incidents of the week and category: the omitted entries. */
export async function listOmittedIncidents(
  client: Queryable,
  weekRunId: string,
  category: string,
  limit: number,
): Promise<{ readonly incidentId: string; readonly title: string; readonly reason: string }[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > SELECTION_PAGE_MAX)
    throw new DatabaseError('query', 'selection page size out of range');
  const result = await client.query<{ incident_id: string; title: string | null; note: string }>(
    `WITH latest AS (
       SELECT DISTINCT ON (incident_id) incident_id, clustering_run_id, batch_id, state, note, created_at
         FROM issue_selections WHERE week_run_id = $1 AND category = $2
        ORDER BY incident_id, revision DESC
     )
     SELECT l.incident_id, rs.normalized_title AS title, l.note
       FROM latest l
       JOIN incident_clusters c ON c.id = l.incident_id AND c.clustering_run_id = l.clustering_run_id AND c.batch_id = l.batch_id
       JOIN source_rows rs ON rs.id = c.representative_source_row_id
      WHERE l.state = 'unselected' AND l.note IS NOT NULL
      ORDER BY l.created_at, l.incident_id
      LIMIT $3`,
    [weekRunId, category, limit],
  );
  return result.rows.map((row) => ({
    incidentId: row.incident_id,
    title: row.title ?? '',
    reason: row.note,
  }));
}
