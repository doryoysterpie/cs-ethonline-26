import type { AssociationRelation, ChainId, DataOrigin, EvidenceState } from '@cas/contracts';
import { openDatabase, quoteIdentifier, type DatabaseConfig, type Queryable } from '@cas/database';

import {
  CANCEL_POOL_CONNECTIONS,
  DATABASE_MAX_CONNECTIONS,
  HEADLINE_MAX_CHARACTERS,
  PUBLISHER_MAX_CHARACTERS,
  STATEMENT_TIMEOUT_MS,
  TEXT_FETCH_MARGIN_MAX_CHARACTERS,
  TEXT_FETCH_MARGIN_MIN_CHARACTERS,
  URL_MAX_CHARACTERS,
} from '../bounds.js';
import { throwIfAborted } from '../safety/cancellation.js';
import { ToolError } from '../safety/errors.js';
import { verifyDatabasePrivileges, type PrivilegeReport } from './privileges.js';
import type {
  BoundedText,
  DraftIncidentRow,
  DraftSourceRow,
  EvidenceRunRow,
  IncidentAssociationRow,
  IncidentReadStore,
  IncidentReadStoreProvider,
  IncidentSourceRow,
  IncidentSummaryRow,
  ReadTransactionOptions,
  SignalObservationRow,
  SignalRunBoundary,
  SignalRunRow,
  SignalTargetRow,
} from './read-store.js';

/**
 * The PostgreSQL read store.
 *
 * One tool call is one connection, one transaction and one snapshot:
 *
 *   - `withReadOnlyConnection` opens a pool of exactly one connection through
 *     `@cas/database`, the only package that talks to PostgreSQL, begins the
 *     transaction `REPEATABLE READ` and `READ ONLY` on the `BEGIN` itself,
 *     sets a `SET LOCAL statement_timeout`, runs the call, commits, and then
 *     closes the pool. Closing the pool ends the connection, so no `SET`, no
 *     search path, no temporary object, no prepared statement and no advisory
 *     lock can survive into another call. The database refuses any write on
 *     the connection with SQLSTATE 25006 before the role's own privileges are
 *     even consulted.
 *   - in production mode the provider runs the privilege matrix on that same
 *     connection before the first application read, and refuses the call if
 *     the effective role holds more than read access to the required tables.
 *   - every read of one call goes through one `PostgresReadStore` bound to
 *     that connection, so run metadata, incidents, sources, associations,
 *     review state, targets, signal history and draft data come from one
 *     snapshot. A review action or a signal run committed while the call is
 *     in flight is seen by the next call, never by this one.
 *
 * Cancellation (Track D finding F1) is the database's too. The call's one
 * abort signal, owned by the runtime, reaches this transaction: every
 * statement checks it first, so an aborted call sends nothing further; and
 * the transaction records its backend process id when it opens, so that when
 * the signal fires while a statement is in flight, a separate one-connection
 * pool issues `pg_cancel_backend` for that process and the server stops the
 * statement with SQLSTATE 57014 rather than leaving it to run until a lock
 * clears or the statement timeout fires. The cancelled transaction is rolled
 * back and its connection destroyed before the call reports.
 *
 * Every statement is fixed text with parameters. Every relation is named by
 * its schema and every built-in function, aggregate, operator and type by
 * `pg_catalog`, so a function or relation of the same name in an application
 * or temporary schema cannot answer in their place. Text columns are fetched
 * as a bounded prefix plus the stored value's true size (`BoundedText`), so a
 * 48,000-character cell never crosses the wire and the display layer can say
 * when it cut something. The only literal interpolated into SQL is the
 * statement timeout, a fixed integer constant, and the schema identifier,
 * validated as a plain identifier and quoted.
 */

if (!Number.isInteger(STATEMENT_TIMEOUT_MS) || STATEMENT_TIMEOUT_MS <= 0) {
  throw new TypeError('statement timeout must be a positive integer');
}

export type StoreMode = 'production' | 'development';

/**
 * Sizes the sentinel margin from the lengths of the secrets the runtime holds:
 * three times the longest, so a percent-encoded form of it also fits whole,
 * plus a little, within the fixed limits.
 */
export function textFetchMargin(secretLengths: readonly number[]): number {
  const longest = secretLengths.reduce((max, length) => Math.max(max, length), 0);
  return Math.min(
    TEXT_FETCH_MARGIN_MAX_CHARACTERS,
    Math.max(TEXT_FETCH_MARGIN_MIN_CHARACTERS, 3 * longest + 16),
  );
}

function abortable(client: Queryable, signal: AbortSignal | undefined): Queryable {
  if (signal === undefined) return client;
  return {
    query: <R extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
      // Every statement of the call observes the signal before it is sent, so
      // an aborted call sends nothing further. The fixed error carries the
      // cause (deadline, client cancellation or shutdown) the runtime set.
      throwIfAborted(signal);
      return client.query<R>(text, values);
    },
  };
}

/**
 * Arms server-side cancellation for one open transaction: records the backend
 * process id on the transaction's own connection, and when the signal fires
 * issues `pg_cancel_backend` for it from a separate one-connection pool, so
 * the cancel never waits behind the very statement it cancels. That pool is
 * destroyed as soon as the cancel is sent. Returns the function that detaches
 * the listener once the call has ended on its own.
 *
 * The cancel is deliberately off the call's critical path, so the call can
 * report while the cancelling connection is still open. Its closing promise is
 * handed to `registerCancellation`, which is how shutdown waits for that
 * connection too (Track D finding F1). The cancel runs on the call's own
 * credential, which is allowed to signal its own sessions; no
 * `pg_signal_backend` membership or other elevated privilege is required, and
 * the reader role is never granted one.
 */
async function armCancellation(
  config: DatabaseConfig,
  transaction: Queryable,
  signal: AbortSignal,
  registerCancellation: ((closed: Promise<void>) => void) | undefined,
): Promise<() => void> {
  const backend = await transaction.query<{ pid: number }>(
    'SELECT pg_catalog.pg_backend_pid() AS pid',
  );
  const pid = backend.rows[0]?.pid ?? null;
  const cancelBackend = (): void => {
    if (pid === null) return;
    const closed = (async () => {
      const canceller = openDatabase(config, { maxConnections: CANCEL_POOL_CONNECTIONS });
      try {
        await canceller.withClient((client) =>
          client.query('SELECT pg_catalog.pg_cancel_backend($1::pg_catalog.int4)', [pid]),
        );
      } catch {
        // The statement timeout remains the bound when the cancel cannot be sent.
      } finally {
        await canceller.end().catch(() => undefined);
      }
    })();
    registerCancellation?.(closed);
  };
  if (signal.aborted) {
    cancelBackend();
    return () => undefined;
  }
  signal.addEventListener('abort', cancelBackend, { once: true });
  return () => signal.removeEventListener('abort', cancelBackend);
}

/**
 * Opens one connection, runs `fn` inside one `REPEATABLE READ`, `READ ONLY`
 * transaction with a statement timeout, commits, and destroys the connection
 * whatever happened. The schema handed to `fn` is the one the handle
 * addresses, validated as a plain identifier. When a signal is supplied, no
 * statement is sent once it has aborted and a statement already in flight is
 * cancelled at the server.
 */
export async function withReadOnlyConnection<T>(
  config: DatabaseConfig,
  fn: (client: Queryable, schema: string) => Promise<T>,
  options: ReadTransactionOptions = {},
): Promise<T> {
  const signal = options.signal;
  throwIfAborted(signal);
  const db = openDatabase(config, { maxConnections: DATABASE_MAX_CONNECTIONS });
  try {
    return await db.withClient(async (raw) => {
      const client = abortable(raw, signal);
      // Read-only on the BEGIN itself: no statement of this transaction ever
      // runs before the declaration.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      let committed = false;
      let disarm: () => void = () => undefined;
      try {
        if (signal !== undefined) {
          disarm = await armCancellation(config, client, signal, options.registerCancellation);
        }
        await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        const result = await fn(client, db.schema);
        await client.query('COMMIT');
        committed = true;
        return result;
      } finally {
        disarm();
        if (!committed) {
          try {
            await raw.query('ROLLBACK');
          } catch {
            // The connection is destroyed below whatever state it is in.
          }
        }
      }
    });
  } finally {
    // Ends the pool's single connection. Nothing of this call's session
    // survives: not a setting, not a temporary object, not a lock.
    await db.end();
  }
}

// ---------------------------------------------------------------------------
// Statements. `schema` is the quoted application schema identifier.

const BOUNDED = (column: string, parameter: string, alias: string): string =>
  `pg_catalog.left(${column}, ${parameter}::pg_catalog.int4) AS ${alias}_fragment,
       pg_catalog.char_length(${column}) AS ${alias}_characters,
       pg_catalog.octet_length(${column}) AS ${alias}_bytes`;

const INSTANT = (column: string): string =>
  `pg_catalog.to_json(${column}) OPERATOR(pg_catalog.#>>) '{}'`;

function statements(schema: string) {
  return {
    evidenceRun: `
      SELECT id, clustering_run_id, batch_id, signal_run_id, data_origin, status,
             resolver_version, contract_version, contract_hash, incident_count,
             reported_only_count, onchain_observed_count, corroborated_count, contradicted_count,
             ${INSTANT('completed_at')} AS completed_at
        FROM ${schema}.evidence_runs
       WHERE id = $1::pg_catalog.uuid`,
    signalRun: `
      SELECT id, data_origin, status, signal_version, contract_version, contract_hash,
             query_sha256, gateway_host, target_count, signal_count, failed_target_count,
             ${INSTANT('completed_at')} AS completed_at
        FROM ${schema}.graph_signal_runs
       WHERE id = $1::pg_catalog.uuid`,
    // Grouped by the primary keys of every joined table, so each selected
    // column is functionally dependent and the title is never a grouping key.
    summaries: `
      SELECT s.incident_cluster_id AS incident_id,
             c.kind, c.member_count, c.reason_codes,
             s.state, s.reason_code, s.claim_id, s.accepted_association_count,
             sub.chain AS subject_chain, sub.protocol_slug AS subject_protocol_slug,
             ${BOUNDED('rep.normalized_title', '$4', 'headline')},
             ${INSTANT('pg_catalog.min(r.posted_at)')} AS earliest_reported_at,
             pg_catalog.count(DISTINCT m.source_row_id)::pg_catalog.int4 AS source_count,
             cr.data_origin
        FROM ${schema}.incident_evidence_states s
        JOIN ${schema}.incident_clusters c
          ON c.id = s.incident_cluster_id AND c.clustering_run_id = s.clustering_run_id
        JOIN ${schema}.clustering_runs cr ON cr.id = c.clustering_run_id
        LEFT JOIN ${schema}.incident_subjects sub
          ON sub.incident_cluster_id = c.id AND sub.clustering_run_id = c.clustering_run_id
        LEFT JOIN ${schema}.source_rows rep ON rep.id = c.representative_source_row_id
        LEFT JOIN ${schema}.incident_memberships m
          ON m.incident_cluster_id = c.id AND m.clustering_run_id = c.clustering_run_id
        LEFT JOIN ${schema}.source_rows r ON r.id = m.source_row_id
       WHERE s.evidence_run_id = $1::pg_catalog.uuid
         AND ($2::pg_catalog.uuid IS NULL OR s.incident_cluster_id > $2::pg_catalog.uuid)
         AND ($5::pg_catalog.uuid IS NULL OR s.incident_cluster_id = $5::pg_catalog.uuid)
       GROUP BY s.id, c.id, cr.id, sub.id, rep.id
       ORDER BY s.incident_cluster_id
       LIMIT $3::pg_catalog.int4`,
    sources: `
      SELECT r.id AS source_row_id,
             ${BOUNDED('r.normalized_title', '$4', 'title')},
             ${BOUNDED('r.raw_category', '$5', 'publisher')},
             ${BOUNDED('r.canonical_url', '$6', 'url')},
             ${INSTANT('r.posted_at')} AS posted_at,
             m.decision
        FROM ${schema}.incident_memberships m
        JOIN ${schema}.source_rows r ON r.id = m.source_row_id
       WHERE m.clustering_run_id = $1::pg_catalog.uuid
         AND m.incident_cluster_id = $2::pg_catalog.uuid
       ORDER BY r.id
       LIMIT $3::pg_catalog.int4`,
    // The latest decision on this incident-and-signal pair within the
    // clustering run, exactly as the resolver reads it. The suggestion row is
    // never edited, so the machine's proposal and the human's answer are
    // returned side by side.
    associations: `
      SELECT a.id, a.signal_id, a.chain, g.protocol_slug,
             ${INSTANT('g.observed_at')} AS observed_at,
             g.delta_percent::pg_catalog.text AS delta_percent, g.data_origin AS signal_origin,
             a.offset_seconds, a.relation, a.claim_id, a.reason_codes,
             latest.status AS decided_status, latest.relation AS decided_relation,
             latest.claim_id AS decided_claim_id
        FROM ${schema}.incident_signal_associations a
        JOIN ${schema}.graph_signals g ON g.id = a.signal_id
        LEFT JOIN LATERAL (
          SELECT CASE WHEN r.operation = 'accept' THEN 'accepted' ELSE 'rejected' END AS status,
                 r.relation, r.claim_id
            FROM ${schema}.evidence_review_actions r
            JOIN ${schema}.incident_signal_associations d ON d.id = r.association_id
           WHERE d.clustering_run_id = a.clustering_run_id
             AND d.incident_cluster_id = a.incident_cluster_id
             AND d.signal_id = a.signal_id
           ORDER BY r.created_at DESC, r.resulting_revision DESC, r.id DESC
           LIMIT 1
        ) latest ON true
       WHERE a.evidence_run_id = $1::pg_catalog.uuid
         AND a.incident_cluster_id = $2::pg_catalog.uuid
       ORDER BY a.signal_id
       LIMIT $3::pg_catalog.int4`,
    // The targets the boundary knows: observed by a completed, compatible run
    // that completed at or before the named run. A target that stopped
    // reporting before the named run is still evaluated, and reported stale
    // or missing rather than dropped; a target first seen after it does not
    // exist for this evaluation.
    targets: `
      SELECT DISTINCT g.chain, g.protocol_slug
        FROM ${schema}.graph_signals g
        JOIN ${schema}.graph_signal_runs r ON r.id = g.signal_run_id
       WHERE r.status = 'completed'
         AND r.completed_at <= $1::pg_catalog.timestamptz
         AND r.data_origin = $2::pg_catalog.text
         AND g.data_origin = $2::pg_catalog.text
         AND r.signal_version = $3::pg_catalog.text
       ORDER BY g.chain, g.protocol_slug
       LIMIT $4::pg_catalog.int4`,
    // The as-of cut is in the WHERE clause, before the LIMIT. Ordering is by
    // observation instant, then the completion instant of the run that
    // recorded it, then the signal identifier, so equal instants select the
    // same rows in the same order every time.
    history: `
      SELECT ${INSTANT('g.observed_at')} AS observed_at,
             g.delta_percent::pg_catalog.text AS delta_percent,
             g.signal_run_id, g.id AS signal_id,
             ${INSTANT('r.completed_at')} AS run_completed_at
        FROM ${schema}.graph_signals g
        JOIN ${schema}.graph_signal_runs r ON r.id = g.signal_run_id
       WHERE g.chain = $1::pg_catalog.text
         AND g.protocol_slug = $2::pg_catalog.text
         AND g.data_origin = $3::pg_catalog.text
         AND r.data_origin = $3::pg_catalog.text
         AND r.status = 'completed'
         AND r.completed_at <= $4::pg_catalog.timestamptz
         AND r.signal_version = $5::pg_catalog.text
         AND g.observed_at <= $6::pg_catalog.timestamptz
       ORDER BY g.observed_at DESC, r.completed_at DESC, g.id DESC
       LIMIT $7::pg_catalog.int4`,
    // Bounded before anything is fetched: at most `$2` incidents, then at most
    // `$3` memberships of each in source-row order, then the bounded columns
    // of exactly those source rows. The membership total is counted, never
    // fetched, so the omission can be reported without paying for the text.
    draft: `
      WITH incidents AS (
        SELECT s.incident_cluster_id AS incident_id, s.clustering_run_id, s.batch_id,
               r.data_origin, s.state, (sub.id IS NOT NULL) AS has_subject
          FROM ${schema}.incident_evidence_states s
          JOIN ${schema}.evidence_runs r ON r.id = s.evidence_run_id
          LEFT JOIN ${schema}.incident_subjects sub
            ON sub.incident_cluster_id = s.incident_cluster_id
           AND sub.clustering_run_id = s.clustering_run_id
         WHERE s.evidence_run_id = $1::pg_catalog.uuid
         ORDER BY s.incident_cluster_id
         LIMIT $2::pg_catalog.int4
      ),
      members AS (
        SELECT i.incident_id, m.source_row_id,
               pg_catalog.row_number() OVER (
                 PARTITION BY i.incident_id ORDER BY m.source_row_id, m.id) AS position,
               pg_catalog.count(*) OVER (PARTITION BY i.incident_id) AS member_total
          FROM incidents i
          JOIN ${schema}.incident_memberships m
            ON m.incident_cluster_id = i.incident_id AND m.clustering_run_id = i.clustering_run_id
      )
      SELECT i.incident_id, i.clustering_run_id, i.batch_id, i.data_origin, i.state, i.has_subject,
             mem.source_row_id,
             mem.position::pg_catalog.int4 AS position,
             mem.member_total::pg_catalog.int4 AS member_total,
             ${BOUNDED('sr.normalized_title', '$4', 'title')},
             ${BOUNDED('sr.raw_category', '$5', 'publisher')},
             ${BOUNDED('sr.canonical_url', '$6', 'url')},
             ${INSTANT('sr.posted_at')} AS posted_at
        FROM incidents i
        LEFT JOIN members mem
          ON mem.incident_id = i.incident_id AND mem.position <= $3::pg_catalog.int4
        LEFT JOIN ${schema}.source_rows sr ON sr.id = mem.source_row_id
       ORDER BY i.incident_id, mem.position`,
  };
}

// ---------------------------------------------------------------------------
// Row shapes.

interface EvidenceRunRecord {
  id: string;
  clustering_run_id: string;
  batch_id: string;
  signal_run_id: string;
  data_origin: DataOrigin;
  status: 'running' | 'completed';
  resolver_version: string;
  contract_version: string;
  contract_hash: string;
  incident_count: number;
  reported_only_count: number;
  onchain_observed_count: number;
  corroborated_count: number;
  contradicted_count: number;
  completed_at: string | null;
}

interface SignalRunRecord {
  id: string;
  data_origin: DataOrigin;
  status: 'running' | 'completed';
  signal_version: string;
  contract_version: string;
  contract_hash: string;
  query_sha256: string;
  gateway_host: string;
  target_count: number;
  signal_count: number;
  failed_target_count: number;
  completed_at: string | null;
}

interface SummaryRecord {
  incident_id: string;
  kind: string;
  member_count: number;
  reason_codes: unknown;
  state: EvidenceState;
  reason_code: string;
  claim_id: string | null;
  accepted_association_count: number;
  subject_chain: ChainId | null;
  subject_protocol_slug: string | null;
  headline_fragment: string | null;
  headline_characters: number | null;
  headline_bytes: number | null;
  earliest_reported_at: string | null;
  source_count: number;
  data_origin: DataOrigin;
}

interface SourceRecord {
  source_row_id: string;
  title_fragment: string | null;
  title_characters: number | null;
  title_bytes: number | null;
  publisher_fragment: string | null;
  publisher_characters: number | null;
  publisher_bytes: number | null;
  url_fragment: string | null;
  url_characters: number | null;
  url_bytes: number | null;
  posted_at: string | null;
  decision: 'include' | 'review';
}

interface AssociationRecord {
  id: string;
  signal_id: string;
  chain: ChainId;
  protocol_slug: string;
  observed_at: string;
  delta_percent: string;
  signal_origin: DataOrigin;
  offset_seconds: number;
  relation: AssociationRelation;
  claim_id: string | null;
  reason_codes: unknown;
  decided_status: 'accepted' | 'rejected' | null;
  decided_relation: AssociationRelation | null;
  decided_claim_id: string | null;
}

interface TargetRecord {
  chain: ChainId;
  protocol_slug: string;
}

interface HistoryRecord {
  observed_at: string;
  delta_percent: string;
  signal_run_id: string;
  signal_id: string;
  run_completed_at: string;
}

interface DraftRecord {
  incident_id: string;
  clustering_run_id: string;
  batch_id: string;
  data_origin: DataOrigin;
  state: EvidenceState;
  has_subject: boolean;
  source_row_id: string | null;
  position: number | null;
  member_total: number | null;
  title_fragment: string | null;
  title_characters: number | null;
  title_bytes: number | null;
  publisher_fragment: string | null;
  publisher_characters: number | null;
  publisher_bytes: number | null;
  url_fragment: string | null;
  url_characters: number | null;
  url_bytes: number | null;
  posted_at: string | null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function bounded(
  fragment: string | null,
  characters: number | null,
  bytes: number | null,
): BoundedText | null {
  if (fragment === null || characters === null || bytes === null) return null;
  return { fragment, characters, bytes };
}

function toSummary(row: SummaryRecord): IncidentSummaryRow {
  return {
    incidentId: row.incident_id,
    kind: row.kind,
    memberCount: row.member_count,
    sourceCount: row.source_count,
    reasonCodes: stringList(row.reason_codes),
    state: row.state,
    stateReasonCode: row.reason_code,
    claimId: row.claim_id,
    acceptedAssociationCount: row.accepted_association_count,
    subjectChain: row.subject_chain,
    subjectProtocolSlug: row.subject_protocol_slug,
    headline: bounded(row.headline_fragment, row.headline_characters, row.headline_bytes),
    earliestReportedAt: row.earliest_reported_at,
    dataOrigin: row.data_origin,
  };
}

function toDraftSource(row: DraftRecord | SourceRecord, sourceRowId: string): DraftSourceRow {
  return {
    sourceRowId,
    title: bounded(row.title_fragment, row.title_characters, row.title_bytes),
    publisher: bounded(row.publisher_fragment, row.publisher_characters, row.publisher_bytes),
    url: bounded(row.url_fragment, row.url_characters, row.url_bytes),
    postedAt: row.posted_at,
  };
}

// ---------------------------------------------------------------------------
// The transaction-bound store.

/** Reads of one transaction. Construct one per call, over that call's connection. */
export class PostgresReadStore implements IncidentReadStore {
  readonly #client: Queryable;
  readonly #sql: ReturnType<typeof statements>;
  /** Characters fetched per bounded column: the display bound plus the sentinel margin. */
  readonly #fetch: { readonly headline: number; readonly publisher: number; readonly url: number };

  constructor(client: Queryable, schema: string, textFetchMarginCharacters: number) {
    this.#client = client;
    this.#sql = statements(quoteIdentifier(schema));
    const margin = Math.trunc(textFetchMarginCharacters);
    if (margin < TEXT_FETCH_MARGIN_MIN_CHARACTERS || margin > TEXT_FETCH_MARGIN_MAX_CHARACTERS) {
      throw new TypeError('text fetch margin outside its fixed limits');
    }
    this.#fetch = {
      headline: HEADLINE_MAX_CHARACTERS + margin,
      publisher: PUBLISHER_MAX_CHARACTERS + margin,
      url: URL_MAX_CHARACTERS + margin,
    };
  }

  async getEvidenceRun(evidenceRunId: string): Promise<EvidenceRunRow | null> {
    const result = await this.#client.query<EvidenceRunRecord>(this.#sql.evidenceRun, [
      evidenceRunId,
    ]);
    const run = result.rows[0];
    return run === undefined
      ? null
      : {
          id: run.id,
          clusteringRunId: run.clustering_run_id,
          batchId: run.batch_id,
          signalRunId: run.signal_run_id,
          dataOrigin: run.data_origin,
          status: run.status,
          resolverVersion: run.resolver_version,
          contractVersion: run.contract_version,
          contractHash: run.contract_hash,
          incidentCount: run.incident_count,
          reportedOnlyCount: run.reported_only_count,
          onchainObservedCount: run.onchain_observed_count,
          corroboratedCount: run.corroborated_count,
          contradictedCount: run.contradicted_count,
          completedAt: run.completed_at,
        };
  }

  async listIncidentSummaries(
    evidenceRunId: string,
    afterIncidentId: string | null,
    limit: number,
  ): Promise<IncidentSummaryRow[]> {
    const result = await this.#client.query<SummaryRecord>(this.#sql.summaries, [
      evidenceRunId,
      afterIncidentId,
      limit,
      this.#fetch.headline,
      null,
    ]);
    return result.rows.map(toSummary);
  }

  async getIncidentSummary(
    evidenceRunId: string,
    incidentId: string,
  ): Promise<IncidentSummaryRow | null> {
    const result = await this.#client.query<SummaryRecord>(this.#sql.summaries, [
      evidenceRunId,
      null,
      1,
      this.#fetch.headline,
      incidentId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toSummary(row);
  }

  async listIncidentSources(
    clusteringRunId: string,
    incidentId: string,
    limit: number,
  ): Promise<IncidentSourceRow[]> {
    const result = await this.#client.query<SourceRecord>(this.#sql.sources, [
      clusteringRunId,
      incidentId,
      limit,
      this.#fetch.headline,
      this.#fetch.publisher,
      this.#fetch.url,
    ]);
    return result.rows.map((row) => ({
      ...toDraftSource(row, row.source_row_id),
      decision: row.decision,
    }));
  }

  async listIncidentAssociations(
    evidenceRunId: string,
    incidentId: string,
    limit: number,
  ): Promise<IncidentAssociationRow[]> {
    const result = await this.#client.query<AssociationRecord>(this.#sql.associations, [
      evidenceRunId,
      incidentId,
      limit,
    ]);
    return result.rows.map((row) => ({
      associationId: row.id,
      signalId: row.signal_id,
      chain: row.chain,
      protocolSlug: row.protocol_slug,
      signalObservedAt: row.observed_at,
      signalDeltaPercent: row.delta_percent,
      signalDataOrigin: row.signal_origin,
      offsetSeconds: row.offset_seconds,
      suggestedRelation: row.relation,
      suggestedClaimId: row.claim_id,
      decidedStatus: row.decided_status,
      decidedRelation: row.decided_relation,
      decidedClaimId: row.decided_claim_id,
      reasonCodes: stringList(row.reason_codes),
    }));
  }

  async getSignalRun(signalRunId: string): Promise<SignalRunRow | null> {
    const result = await this.#client.query<SignalRunRecord>(this.#sql.signalRun, [signalRunId]);
    const run = result.rows[0];
    return run === undefined
      ? null
      : {
          id: run.id,
          dataOrigin: run.data_origin,
          status: run.status,
          signalVersion: run.signal_version,
          contractVersion: run.contract_version,
          contractHash: run.contract_hash,
          querySha256: run.query_sha256,
          gatewayHost: run.gateway_host,
          targetCount: run.target_count,
          signalCount: run.signal_count,
          failedTargetCount: run.failed_target_count,
          completedAt: run.completed_at,
        };
  }

  async listSignalTargets(boundary: SignalRunBoundary, limit: number): Promise<SignalTargetRow[]> {
    const result = await this.#client.query<TargetRecord>(this.#sql.targets, [
      boundary.completedAt,
      boundary.dataOrigin,
      boundary.signalVersion,
      limit,
    ]);
    return result.rows.map((row) => ({
      chain: row.chain,
      protocolSlug: row.protocol_slug,
      dataOrigin: boundary.dataOrigin,
    }));
  }

  async listSignalHistory(
    boundary: SignalRunBoundary,
    chain: ChainId,
    protocolSlug: string,
    limit: number,
  ): Promise<SignalObservationRow[]> {
    const result = await this.#client.query<HistoryRecord>(this.#sql.history, [
      chain,
      protocolSlug,
      boundary.dataOrigin,
      boundary.completedAt,
      boundary.signalVersion,
      boundary.asOf,
      limit,
    ]);
    return result.rows
      .map((row) => ({
        observedAt: row.observed_at,
        deltaPercent: row.delta_percent,
        signalRunId: row.signal_run_id,
        signalId: row.signal_id,
        runCompletedAt: row.run_completed_at,
      }))
      .reverse();
  }

  async listDraftIncidents(
    evidenceRunId: string,
    incidentLimit: number,
    sourcesPerIncidentLimit: number,
  ): Promise<DraftIncidentRow[]> {
    const result = await this.#client.query<DraftRecord>(this.#sql.draft, [
      evidenceRunId,
      incidentLimit,
      sourcesPerIncidentLimit,
      this.#fetch.headline,
      this.#fetch.publisher,
      this.#fetch.url,
    ]);
    const incidents: DraftIncidentRow[] = [];
    let current: { row: DraftIncidentRow; sources: DraftSourceRow[] } | null = null;
    for (const row of result.rows) {
      if (current === null || current.row.incidentId !== row.incident_id) {
        const sources: DraftSourceRow[] = [];
        current = {
          sources,
          row: {
            incidentId: row.incident_id,
            clusteringRunId: row.clustering_run_id,
            batchId: row.batch_id,
            dataOrigin: row.data_origin,
            state: row.state,
            hasSubject: row.has_subject,
            sourceTotal: row.member_total ?? 0,
            sources,
          },
        };
        incidents.push(current.row);
      }
      if (row.source_row_id !== null) current.sources.push(toDraftSource(row, row.source_row_id));
    }
    return incidents;
  }
}

// ---------------------------------------------------------------------------
// The provider: one transaction per tool call.

export interface PostgresReadStoreOptions {
  readonly mode: StoreMode;
  /** From `textFetchMargin`, sized for the secrets the runtime holds. */
  readonly textFetchMargin: number;
}

export class PostgresReadStoreProvider implements IncidentReadStoreProvider {
  readonly #config: DatabaseConfig;
  readonly #mode: StoreMode;
  readonly #margin: number;
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #cancellations = new Set<Promise<void>>();

  constructor(config: DatabaseConfig, options: PostgresReadStoreOptions) {
    this.#config = config;
    this.#mode = options.mode;
    this.#margin = options.textFetchMargin;
  }

  get mode(): StoreMode {
    return this.#mode;
  }

  /**
   * One connection, one snapshot, one verified role. In production mode the
   * privilege matrix runs on the call's own connection before any application
   * read; an overprivileged credential fails the call with a fixed code and
   * reads nothing.
   */
  async withReadTransaction<T>(
    fn: (store: IncidentReadStore) => Promise<T>,
    options: ReadTransactionOptions = {},
  ): Promise<T> {
    // A cancel runs on a pool of its own, so it can still be closing after the
    // call it cancelled has reported. The provider holds each closing promise
    // so `close` can wait for it; a caller that asked for the same promise
    // still receives it.
    const register = (closed: Promise<void>): void => {
      this.#cancellations.add(closed);
      void closed.then(
        () => this.#cancellations.delete(closed),
        () => this.#cancellations.delete(closed),
      );
      options.registerCancellation?.(closed);
    };
    const call = withReadOnlyConnection(
      this.#config,
      async (client, schema) => {
        if (this.#mode === 'production') {
          const report = await verifyDatabasePrivileges(client, schema);
          if (!report.ok) throw new ToolError('database_role_overprivileged');
        }
        return fn(new PostgresReadStore(client, schema, this.#margin));
      },
      { ...options, registerCancellation: register },
    );
    this.#inFlight.add(call);
    try {
      return await call;
    } finally {
      this.#inFlight.delete(call);
    }
  }

  /** The privilege matrix on a fresh connection, for start-up and the verification command. */
  async verifyPrivileges(options: ReadTransactionOptions = {}): Promise<PrivilegeReport> {
    return withReadOnlyConnection(
      this.#config,
      (client, schema) => verifyDatabasePrivileges(client, schema),
      options,
    );
  }

  /**
   * Waits for in-flight calls to unwind; each destroys its own connection.
   * Then waits for every cancelling connection still closing, so no connection
   * this provider opened outlives the server that closed it.
   */
  async close(): Promise<void> {
    await Promise.allSettled([...this.#inFlight]);
    await Promise.allSettled([...this.#cancellations]);
  }
}
