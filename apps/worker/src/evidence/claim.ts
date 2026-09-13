import { createHash, randomUUID } from 'node:crypto';

import {
  CLAIM_KINDS,
  findIncidentClaimByFingerprint,
  getClusteringRun,
  getIncidentClaim,
  getIncidentMembership,
  insertIncidentClaim,
  isDatabaseError,
  type ClaimKind,
  type Database,
  type IncidentClaimRecord,
} from '@cas/database';

import { assertReviewNote } from '../clustering/note.js';
import { IngestionError } from '../editorial/errors.js';

/**
 * Recording a claim about an incident (audit finding F2).
 *
 * `corroborated` and `contradicted` are statements about a claim, and a claim
 * has to be something a person can point at: this incident, resting on this
 * source row, which is a member of this incident under this clustering run,
 * with this row hash, in this batch, of this origin. That is what a claim
 * record holds, and the database proves the membership by composite foreign
 * key rather than taking the caller's word for it.
 *
 * Nothing here extracts a claim from text. A person records one, names the
 * row it rests on, gives it a bounded kind and a bounded statement, and signs
 * it with an actor and a reason code. The fingerprint is the canonical digest
 * of that identity, so recording the same claim twice is the same claim.
 *
 * A claim is append-only. Correcting one means recording another; nothing a
 * person asserted is rewritten.
 */

export interface RecordClaimRequest {
  readonly clusteringRunId: string;
  readonly incidentId: string;
  readonly sourceRowId: string;
  readonly claimKind: ClaimKind;
  readonly statement: string;
  readonly actor: string;
  readonly reasonCode: string;
}

export interface RecordClaimOutcome {
  readonly outcome: 'recorded' | 'already_recorded';
  readonly claim: IncidentClaimRecord;
}

const REASON_CODE = /^[a-z][a-z0-9_]{2,63}$/u;
const ACTOR = /^[a-z][a-z0-9_.:-]{1,63}$/u;

function configuration(code: string, message: string): IngestionError {
  return new IngestionError('configuration', code, message);
}

/** A claim kind from the closed set, or a fixed refusal. */
export function parseClaimKind(value: string | undefined): ClaimKind {
  if (value !== undefined && (CLAIM_KINDS as readonly string[]).includes(value)) {
    return value as ClaimKind;
  }
  throw configuration(
    'claim_kind_invalid',
    '--kind must be reported_headline or recorded_statement',
  );
}

/**
 * The statement carries the review-note character policy and, unlike a note,
 * is required: a claim with nothing said is not a claim.
 */
export function assertClaimStatement(value: string | null | undefined): string {
  const statement = assertReviewNote(value);
  if (statement === null) {
    throw configuration('statement_required', '--statement is required');
  }
  return statement;
}

/**
 * Frames the fields of the fingerprint. NUL cannot occur in a UUID, a hash, a
 * kind or a policy-checked statement, so no value can imitate a boundary. It
 * is spelled out as an escape: a raw control byte in source is invisible in
 * review and is exactly what this project's own hygiene guard refuses.
 */
const FIELD_SEPARATOR = '\u0000';

/** Canonical identity of a claim. Field-framed, never composed from free text alone. */
export function claimFingerprint(input: {
  readonly clusteringRunId: string;
  readonly incidentId: string;
  readonly sourceRowId: string;
  readonly rowHash: string;
  readonly claimKind: ClaimKind;
  readonly statement: string;
}): string {
  return createHash('sha256')
    .update(
      [
        'cas.evidence.claim.v1',
        input.clusteringRunId.toLowerCase(),
        input.incidentId.toLowerCase(),
        input.sourceRowId.toLowerCase(),
        input.rowHash,
        input.claimKind,
        `${Buffer.byteLength(input.statement, 'utf8')}:${input.statement}`,
      ].join(FIELD_SEPARATOR),
      'utf8',
    )
    .digest('hex');
}

/** Records one claim, or returns the identical claim already recorded. */
export async function recordIncidentClaim(
  db: Database,
  request: RecordClaimRequest,
  options: {
    readonly now?: (() => Date) | undefined;
    readonly makeId?: (() => string) | undefined;
  } = {},
): Promise<RecordClaimOutcome> {
  // Validated before anything is hashed, stored or looked up.
  const statement = assertClaimStatement(request.statement);
  const claimKind = parseClaimKind(request.claimKind);
  if (!REASON_CODE.test(request.reasonCode)) {
    throw configuration('reason_invalid', '--reason must be a lower-case reason code');
  }
  if (!ACTOR.test(request.actor)) {
    throw configuration('actor_invalid', '--actor must be a lower-case actor identifier');
  }

  const clustering = await db.withClient((client) =>
    getClusteringRun(client, request.clusteringRunId),
  );
  if (clustering === null || clustering.status !== 'completed') {
    throw configuration('clustering_run_not_completed', 'no completed clustering run with that id');
  }

  // The membership is read from the database, never taken from the request.
  // A row that is not a member of this incident under this run cannot be
  // cited, and the foreign key in migration 0009 refuses it again on write.
  const membership = await db.withClient((client) =>
    getIncidentMembership(client, clustering.id, request.incidentId, request.sourceRowId),
  );
  if (membership === null) {
    throw configuration(
      'source_row_not_member',
      'the cited source row is not a member of that incident under this clustering run',
    );
  }

  const fingerprint = claimFingerprint({
    clusteringRunId: clustering.id,
    incidentId: membership.incidentClusterId,
    sourceRowId: membership.sourceRowId,
    rowHash: membership.rowHash,
    claimKind,
    statement,
  });
  const existing = await db.withClient((client) =>
    findIncidentClaimByFingerprint(
      client,
      clustering.id,
      membership.incidentClusterId,
      fingerprint,
    ),
  );
  if (existing !== null) return { outcome: 'already_recorded', claim: existing };

  const now = options.now ?? (() => new Date());
  const makeId = options.makeId ?? randomUUID;
  const id = makeId();
  try {
    await db.withTransaction((tx) =>
      insertIncidentClaim(tx, {
        id,
        clusteringRunId: clustering.id,
        batchId: membership.batchId,
        incidentClusterId: membership.incidentClusterId,
        dataOrigin: membership.dataOrigin,
        sourceRowId: membership.sourceRowId,
        rowHash: membership.rowHash,
        claimKind,
        statement,
        fingerprint,
        actor: request.actor,
        reasonCode: request.reasonCode,
        createdAt: now().toISOString(),
      }),
    );
  } catch (error) {
    if (isDatabaseError(error) && error.code === '23505') {
      const winner = await db.withClient((client) =>
        findIncidentClaimByFingerprint(
          client,
          clustering.id,
          membership.incidentClusterId,
          fingerprint,
        ),
      );
      if (winner !== null) return { outcome: 'already_recorded', claim: winner };
    }
    throw error;
  }
  const stored = await db.withClient((client) => getIncidentClaim(client, id));
  if (stored === null) {
    throw new IngestionError('database', 'claim_not_stored', 'the claim was not stored');
  }
  return { outcome: 'recorded', claim: stored };
}
