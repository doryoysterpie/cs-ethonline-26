import type { Queryable } from './database.js';
import {
  removedCharactersFrom,
  removedCharactersJson,
  type RemovedCharacter,
} from './removed-characters.js';

/**
 * The article (CAS-005, migration 0016): revisions per week run and category,
 * revision 1 generated with its provenance and the reading record per source,
 * later revisions the owner's edits. Append-only throughout; no fetched text
 * is ever stored (O-1), only each extracted text's digest.
 */

export type ArticleRevisionKind = 'generated' | 'edited';
export type NamingBasis = 'primary_statement' | 'two_independent' | 'none';

/** One source of the selection as the reading stage left it: the outcome code, bytes read, the text's digest. */
export interface ArticleSourceRecord {
  readonly sourceRowId: string;
  readonly status: 'read' | 'partly_read' | 'not_read';
  readonly code: string | null;
  readonly bytes: number;
  readonly digest: string | null;
}

export interface ArticleProvenanceColumns {
  readonly model: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly inputDigest: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicrodollars: number;
  readonly wordCount: number;
  readonly namingBasis: NamingBasis;
  readonly sources: readonly ArticleSourceRecord[];
}

export interface NewArticleRevision {
  readonly weekRunId: string;
  readonly category: string;
  readonly revision: number;
  readonly kind: ArticleRevisionKind;
  readonly slots: unknown;
  readonly markdown: string;
  readonly provenance: ArticleProvenanceColumns | null;
  readonly savedByAccountId: string;
  readonly createdAt: string;
  /** Every character the owner's save removed (migration 0024); none for a generated revision. */
  readonly removedCharacters?: readonly RemovedCharacter[];
}

export interface ArticleRevisionRecord extends NewArticleRevision {
  readonly removedCharacters: readonly RemovedCharacter[];
}

const COLUMNS = `week_run_id, category, revision, kind, slots, markdown, model, prompt_version,
  prompt_hash, input_digest, input_tokens, output_tokens,
  cost_microdollars::text AS cost_microdollars, word_count, naming_basis, sources,
  saved_by_account_id, to_json(created_at) #>> '{}' AS created_at, removed_characters`;

interface Row {
  week_run_id: string;
  category: string;
  revision: number;
  kind: ArticleRevisionKind;
  slots: unknown;
  markdown: string;
  model: string | null;
  prompt_version: string | null;
  prompt_hash: string | null;
  input_digest: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_microdollars: string | null;
  word_count: number | null;
  naming_basis: NamingBasis | null;
  sources: unknown;
  saved_by_account_id: string;
  created_at: string;
  removed_characters: unknown;
}

function toRecord(row: Row): ArticleRevisionRecord {
  const provenance =
    row.kind === 'generated' &&
    row.model !== null &&
    row.prompt_version !== null &&
    row.prompt_hash !== null &&
    row.input_digest !== null &&
    row.input_tokens !== null &&
    row.output_tokens !== null &&
    row.cost_microdollars !== null &&
    row.word_count !== null &&
    row.naming_basis !== null &&
    Array.isArray(row.sources)
      ? {
          model: row.model,
          promptVersion: row.prompt_version,
          promptHash: row.prompt_hash,
          inputDigest: row.input_digest,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          costMicrodollars: Number(row.cost_microdollars),
          wordCount: row.word_count,
          namingBasis: row.naming_basis,
          sources: row.sources as ArticleSourceRecord[],
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
    removedCharacters: removedCharactersFrom(row.removed_characters),
  };
}

export async function insertArticleRevision(
  client: Queryable,
  revision: NewArticleRevision,
): Promise<void> {
  const p = revision.provenance;
  // As for the round-up: only an edit that removed characters names the record (migration 0024).
  const removed = revision.removedCharacters ?? [];
  const record = removed.length > 0;
  await client.query(
    `INSERT INTO article_revisions (week_run_id, category, revision, kind, slots, markdown, model,
       prompt_version, prompt_hash, input_digest, input_tokens, output_tokens, cost_microdollars,
       word_count, naming_basis, sources, saved_by_account_id, created_at${record ? ', removed_characters' : ''})
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17,
       $18::timestamptz${record ? ', $19::jsonb' : ''})`,
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
      p?.inputDigest ?? null,
      p?.inputTokens ?? null,
      p?.outputTokens ?? null,
      p?.costMicrodollars ?? null,
      p?.wordCount ?? null,
      p?.namingBasis ?? null,
      p === null ? null : JSON.stringify(p.sources),
      revision.savedByAccountId,
      revision.createdAt,
      ...(record ? [removedCharactersJson(removed)] : []),
    ],
  );
}

export async function listArticleRevisions(
  client: Queryable,
  weekRunId: string,
  category: string,
): Promise<ArticleRevisionRecord[]> {
  const result = await client.query<Row>(
    `SELECT ${COLUMNS} FROM article_revisions
      WHERE week_run_id = $1 AND category = $2 ORDER BY revision`,
    [weekRunId, category],
  );
  return result.rows.map(toRecord);
}

export async function latestArticleRevision(
  client: Queryable,
  weekRunId: string,
  category: string,
): Promise<ArticleRevisionRecord | null> {
  const result = await client.query<Row>(
    `SELECT ${COLUMNS} FROM article_revisions
      WHERE week_run_id = $1 AND category = $2 ORDER BY revision DESC LIMIT 1`,
    [weekRunId, category],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRecord(row);
}
