import type { AssociationRelation, ChainId, DataOrigin, EvidenceState } from '@cas/contracts';
import {
  getEvidenceRun,
  getGraphSignalRun,
  listDraftIncidents,
  listSignalHistory,
  openDatabase,
  type Database,
  type DatabaseConfig,
  type Queryable,
} from '@cas/database';

import {
  DATABASE_MAX_CONNECTIONS,
  HEADLINE_MAX_CHARACTERS,
  PUBLISHER_MAX_CHARACTERS,
  STATEMENT_TIMEOUT_MS,
  URL_MAX_CHARACTERS,
} from '../bounds.js';
import type {
  DraftIncidentRow,
  EvidenceRunRow,
  IncidentAssociationRow,
  IncidentReadStore,
  IncidentSourceRow,
  IncidentSummaryRow,
  SignalObservationRow,
  SignalRunRow,
  SignalTargetRow,
} from './read-store.js';

/**
 * The PostgreSQL read store.
 *
 * It opens its own small pool through `@cas/database`, the only package that
 * talks to PostgreSQL, and runs every operation inside one transaction that
 * begins `REPEATABLE READ`, is declared `READ ONLY` as its first statement,
 * and carries a `statement_timeout`. The read-only declaration is the
 * database's own guard: a write attempted on this connection is refused with
 * SQLSTATE 25006 by the server, not by a check this code could forget. The
 * integration tests prove that, and prove that every tool leaves the
 * application tables byte-identical.
 *
 * Every statement is parameterized. The only literal interpolated into SQL
 * is the statement timeout, a fixed integer constant. Text columns are cut
 * to their display bound inside the query, so a 48,000-character cell never
 * crosses the wire.
 */

if (!Number.isInteger(STATEMENT_TIMEOUT_MS) || STATEMENT_TIMEOUT_MS <= 0) {
  throw new TypeError('statement timeout must be a positive integer');
}

/** Runs `fn` inside a read-only, repeatable-read transaction with a statement timeout. */
export async function readOnly<T>(db: Database, fn: (client: Queryable) => Promise<T>): Promise<T> {
  return db.withTransaction(
    async (tx) => {
      // Both settings must precede any query in the transaction. The timeout
      // is `SET LOCAL`, so it ends with the transaction.
      await tx.query('SET TRANSACTION READ ONLY');
      await tx.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      return fn(tx);
    },
    { isolationLevel: 'repeatable read' },
  );
}

const SUMMARY_SELECT = `
  SELECT s.incident_cluster_id AS incident_id,
         c.kind, c.member_count, c.reason_codes,
         s.state, s.reason_code, s.claim_id, s.accepted_association_count,
         sub.chain AS subject_chain, sub.protocol_slug AS subject_protocol_slug,
         left(rep.normalized_title, $4) AS headline,
         to_json(MIN(r.posted_at)) #>> '{}' AS earliest_reported_at,
         count(DISTINCT m.source_row_id)::text AS source_count,
         c.data_origin_from_run AS data_origin
    FROM incident_evidence_states s
    JOIN (SELECT ic.id, ic.clustering_run_id, ic.batch_id, ic.kind, ic.member_count, ic.reason_codes,
                 ic.representative_source_row_id, cr.data_origin AS data_origin_from_run
            FROM incident_clusters ic
            JOIN clustering_runs cr ON cr.id = ic.clustering_run_id) c
      ON c.id = s.incident_cluster_id AND c.clustering_run_id = s.clustering_run_id
    LEFT JOIN incident_subjects sub
      ON sub.incident_cluster_id = c.id AND sub.clustering_run_id = c.clustering_run_id
    LEFT JOIN source_rows rep ON rep.id = c.representative_source_row_id
    LEFT JOIN incident_memberships m
      ON m.incident_cluster_id = c.id AND m.clustering_run_id = c.clustering_run_id
    LEFT JOIN source_rows r ON r.id = m.source_row_id
   WHERE s.evidence_run_id = $1
     AND ($2::uuid IS NULL OR s.incident_cluster_id > $2::uuid)
     AND ($5::uuid IS NULL OR s.incident_cluster_id = $5::uuid)
   GROUP BY s.incident_cluster_id, c.kind, c.member_count, c.reason_codes, s.state, s.reason_code,
            s.claim_id, s.accepted_association_count, sub.chain, sub.protocol_slug,
            rep.normalized_title, c.data_origin_from_run
   ORDER BY s.incident_cluster_id
   LIMIT $3`;

interface SummaryRow {
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
  headline: string | null;
  earliest_reported_at: string | null;
  source_count: string;
  data_origin: DataOrigin;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function toSummary(row: SummaryRow): IncidentSummaryRow {
  return {
    incidentId: row.incident_id,
    kind: row.kind,
    memberCount: row.member_count,
    sourceCount: Number(row.source_count),
    reasonCodes: stringList(row.reason_codes),
    state: row.state,
    stateReasonCode: row.reason_code,
    claimId: row.claim_id,
    acceptedAssociationCount: row.accepted_association_count,
    subjectChain: row.subject_chain,
    subjectProtocolSlug: row.subject_protocol_slug,
    headline: row.headline,
    earliestReportedAt: row.earliest_reported_at,
    dataOrigin: row.data_origin,
  };
}

export class PostgresReadStore implements IncidentReadStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  static open(config: DatabaseConfig): PostgresReadStore {
    return new PostgresReadStore(
      openDatabase(config, { maxConnections: DATABASE_MAX_CONNECTIONS }),
    );
  }

  async getEvidenceRun(evidenceRunId: string): Promise<EvidenceRunRow | null> {
    return readOnly(this.#db, async (client) => {
      const run = await getEvidenceRun(client, evidenceRunId);
      return run === null
        ? null
        : {
            id: run.id,
            clusteringRunId: run.clusteringRunId,
            batchId: run.batchId,
            signalRunId: run.signalRunId,
            dataOrigin: run.dataOrigin,
            status: run.status,
            resolverVersion: run.resolverVersion,
            contractVersion: run.contractVersion,
            contractHash: run.contractHash,
            incidentCount: run.incidentCount,
            reportedOnlyCount: run.reportedOnlyCount,
            onchainObservedCount: run.onchainObservedCount,
            corroboratedCount: run.corroboratedCount,
            contradictedCount: run.contradictedCount,
            completedAt: run.completedAt,
          };
    });
  }

  async listIncidentSummaries(
    evidenceRunId: string,
    afterIncidentId: string | null,
    limit: number,
  ): Promise<IncidentSummaryRow[]> {
    return readOnly(this.#db, async (client) => {
      const result = await client.query<SummaryRow>(SUMMARY_SELECT, [
        evidenceRunId,
        afterIncidentId,
        limit,
        HEADLINE_MAX_CHARACTERS,
        null,
      ]);
      return result.rows.map(toSummary);
    });
  }

  async getIncidentSummary(
    evidenceRunId: string,
    incidentId: string,
  ): Promise<IncidentSummaryRow | null> {
    return readOnly(this.#db, async (client) => {
      const result = await client.query<SummaryRow>(SUMMARY_SELECT, [
        evidenceRunId,
        null,
        1,
        HEADLINE_MAX_CHARACTERS,
        incidentId,
      ]);
      const row = result.rows[0];
      return row === undefined ? null : toSummary(row);
    });
  }

  async listIncidentSources(
    clusteringRunId: string,
    incidentId: string,
    limit: number,
  ): Promise<IncidentSourceRow[]> {
    return readOnly(this.#db, async (client) => {
      const result = await client.query<{
        source_row_id: string;
        title: string | null;
        publisher: string | null;
        url: string | null;
        posted_at: string | null;
        decision: 'include' | 'review';
      }>(
        `SELECT r.id AS source_row_id,
                left(r.normalized_title, $4) AS title,
                left(r.raw_category, $5) AS publisher,
                left(r.canonical_url, $6) AS url,
                to_json(r.posted_at) #>> '{}' AS posted_at,
                m.decision
           FROM incident_memberships m
           JOIN source_rows r ON r.id = m.source_row_id
          WHERE m.clustering_run_id = $1 AND m.incident_cluster_id = $2
          ORDER BY r.id
          LIMIT $3`,
        [
          clusteringRunId,
          incidentId,
          limit,
          HEADLINE_MAX_CHARACTERS,
          PUBLISHER_MAX_CHARACTERS,
          URL_MAX_CHARACTERS,
        ],
      );
      return result.rows.map((row) => ({
        sourceRowId: row.source_row_id,
        title: row.title,
        publisher: row.publisher,
        url: row.url,
        postedAt: row.posted_at,
        decision: row.decision,
      }));
    });
  }

  async listIncidentAssociations(
    evidenceRunId: string,
    incidentId: string,
    limit: number,
  ): Promise<IncidentAssociationRow[]> {
    return readOnly(this.#db, async (client) => {
      const result = await client.query<{
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
      }>(
        // The latest decision on this incident-and-signal pair within the
        // clustering run, exactly as the resolver reads it. The suggestion row
        // is never edited, so both the machine's proposal and the human's
        // answer are returned side by side.
        `SELECT a.id, a.signal_id, a.chain, g.protocol_slug,
                to_json(g.observed_at) #>> '{}' AS observed_at,
                g.delta_percent::text AS delta_percent, g.data_origin AS signal_origin,
                a.offset_seconds, a.relation, a.claim_id, a.reason_codes,
                latest.status AS decided_status, latest.relation AS decided_relation,
                latest.claim_id AS decided_claim_id
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
          WHERE a.evidence_run_id = $1 AND a.incident_cluster_id = $2
          ORDER BY a.signal_id
          LIMIT $3`,
        [evidenceRunId, incidentId, limit],
      );
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
    });
  }

  async getSignalRun(signalRunId: string): Promise<SignalRunRow | null> {
    return readOnly(this.#db, async (client) => {
      const run = await getGraphSignalRun(client, signalRunId);
      return run === null
        ? null
        : {
            id: run.id,
            dataOrigin: run.dataOrigin,
            status: run.status,
            signalVersion: run.signalVersion,
            contractVersion: run.contractVersion,
            contractHash: run.contractHash,
            querySha256: run.querySha256,
            gatewayHost: run.gatewayHost,
            targetCount: run.targetCount,
            signalCount: run.signalCount,
            failedTargetCount: run.failedTargetCount,
            completedAt: run.completedAt,
          };
    });
  }

  async listSignalTargets(signalRunId: string, limit: number): Promise<SignalTargetRow[]> {
    return readOnly(this.#db, async (client) => {
      const result = await client.query<{
        chain: ChainId;
        protocol_slug: string;
        data_origin: DataOrigin;
      }>(
        // Every target of the named run's origin, as the worker's feed reads
        // them, so a target that stopped reporting is still evaluated and
        // reported stale rather than dropped.
        `SELECT DISTINCT s.chain, s.protocol_slug, s.data_origin
           FROM graph_signals s
           JOIN graph_signal_runs r ON r.id = s.signal_run_id
          WHERE r.status = 'completed'
            AND s.data_origin = (SELECT data_origin FROM graph_signal_runs WHERE id = $1)
          ORDER BY s.chain, s.protocol_slug
          LIMIT $2`,
        [signalRunId, limit],
      );
      return result.rows.map((row) => ({
        chain: row.chain,
        protocolSlug: row.protocol_slug,
        dataOrigin: row.data_origin,
      }));
    });
  }

  async listSignalHistory(
    chain: ChainId,
    protocolSlug: string,
    dataOrigin: DataOrigin,
    limit: number,
  ): Promise<SignalObservationRow[]> {
    return readOnly(this.#db, (client) =>
      listSignalHistory(client, chain, protocolSlug, dataOrigin, limit),
    );
  }

  async listDraftIncidents(evidenceRunId: string, limit: number): Promise<DraftIncidentRow[]> {
    return readOnly(this.#db, async (client) => {
      const rows = await listDraftIncidents(client, evidenceRunId, limit);
      return rows.map((row) => ({
        incidentId: row.incidentId,
        clusteringRunId: row.clusteringRunId,
        batchId: row.batchId,
        dataOrigin: row.dataOrigin,
        state: row.state as EvidenceState,
        hasSubject: row.hasSubject,
        sources: row.sources.map((source) => ({
          sourceRowId: source.sourceRowId,
          title: source.title,
          publisher: source.publisher,
          url: source.url,
          postedAt: source.postedAt,
        })),
      }));
    });
  }

  async close(): Promise<void> {
    await this.#db.end();
  }
}
