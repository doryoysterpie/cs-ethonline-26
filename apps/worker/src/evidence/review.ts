import { createHash, randomUUID } from 'node:crypto';

import type { AssociationRelation } from '@cas/contracts';
import {
  currentEvidenceRevision,
  findEvidenceActionByIdempotencyKey,
  getEvidenceRun,
  insertEvidenceAction,
  isDatabaseError,
  listEvidenceActions,
  type Database,
  type EvidenceActionRecord,
} from '@cas/database';

import { assertReviewNote } from '../clustering/note.js';
import { IngestionError } from '../editorial/errors.js';

/**
 * The human evidence layer: accepting or rejecting a machine suggestion.
 *
 * This is what turns a suggestion into evidence, so it is deliberately the
 * narrowest surface in the sprint. A decision names the association it is
 * about, the relation it asserts, the claim it concerns when it asserts one,
 * a stable reason code, the person making it and an optional bounded
 * rationale. Nothing else is recordable.
 *
 * Two properties carried over from Sprint 4's audit, because the same defects
 * were found there and would be found here:
 *
 *   - **Idempotency is payload-complete.** The stored key covers what was
 *     asked for; a replay whose actor, rationale, relation or claim differs is
 *     a conflict with a fixed error, never a silent repeat of the original.
 *   - **The rationale is validated before it is hashed or written**, by the
 *     same policy the clustering note uses, and again by a CHECK constraint in
 *     migration 0008.
 */

export interface EvidenceDecisionRequest {
  readonly runId: string;
  readonly associationId: string;
  readonly operation: 'accept' | 'reject';
  readonly relation: AssociationRelation;
  readonly claimId?: string | null | undefined;
  readonly reasonCode: string;
  readonly actor: string;
  readonly rationale?: string | null | undefined;
  readonly makeId?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface EvidenceDecisionOutcome {
  readonly outcome: 'recorded' | 'already_recorded';
  readonly action: EvidenceActionRecord;
  readonly revision: number;
}

function configuration(code: string, message: string): IngestionError {
  return new IngestionError('configuration', code, message);
}

/** The identity of what was asked for. Revision is excluded: a replay lands later. */
function actionKey(input: {
  readonly runId: string;
  readonly associationId: string;
  readonly operation: string;
  readonly relation: string;
  readonly reasonCode: string;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** The complete semantic payload, including who asked and what they wrote. */
function canonicalPayload(input: {
  readonly runId: string;
  readonly associationId: string;
  readonly operation: string;
  readonly relation: string;
  readonly claimId: string | null;
  readonly reasonCode: string;
  readonly actor: string;
  readonly rationale: string | null;
}): string {
  return [
    'cas.evidence.review.v1',
    `run:${input.runId.toLowerCase()}`,
    `association:${input.associationId.toLowerCase()}`,
    `operation:${input.operation}`,
    `relation:${input.relation}`,
    `claim:${input.claimId === null ? 'absent' : input.claimId.toLowerCase()}`,
    `reason:${input.reasonCode}`,
    `actor:${input.actor}`,
    input.rationale === null
      ? 'rationale:absent'
      : `rationale:present:${Buffer.byteLength(input.rationale, 'utf8')}:${input.rationale}`,
    '',
  ].join('\n');
}

function payloadOf(action: EvidenceActionRecord): string {
  return canonicalPayload({
    runId: action.evidenceRunId,
    associationId: action.associationId,
    operation: action.operation,
    relation: action.relation,
    claimId: action.claimId,
    reasonCode: action.reasonCode,
    actor: action.actor,
    rationale: action.rationale,
  });
}

/**
 * Refuses a request that reuses an existing decision's identity while
 * differing anywhere in its payload. The message names the condition alone and
 * echoes neither actor nor rationale.
 */
function assertSamePayload(stored: EvidenceActionRecord, submitted: string): void {
  if (payloadOf(stored) === submitted) return;
  throw configuration(
    'evidence_action_conflict',
    'an evidence decision with this identity was already recorded with a different payload',
  );
}

const REASON_CODE = /^[a-z][a-z0-9_]{2,63}$/u;
const ACTOR = /^[a-z][a-z0-9_.:-]{1,63}$/u;

/** Records one accept or reject over a completed evidence run. */
export async function decideAssociation(
  db: Database,
  request: EvidenceDecisionRequest,
): Promise<EvidenceDecisionOutcome> {
  // Validated before anything is hashed, stored or looked up.
  const rationale = assertReviewNote(request.rationale);
  if (!REASON_CODE.test(request.reasonCode)) {
    throw configuration('reason_invalid', '--reason must be a lower-case reason code');
  }
  if (!ACTOR.test(request.actor)) {
    throw configuration('actor_invalid', '--actor must be a lower-case actor identifier');
  }
  const claimId = request.claimId ?? null;
  if (request.operation === 'accept' && request.relation !== 'context' && claimId === null) {
    throw configuration(
      'claim_required',
      'accepting a supporting or conflicting association requires the claim it is about',
    );
  }

  const run = await db.withClient((client) => getEvidenceRun(client, request.runId));
  if (run === null || run.status !== 'completed') {
    throw configuration('evidence_run_not_completed', 'no completed evidence run with that id');
  }

  const key = actionKey({
    runId: run.id,
    associationId: request.associationId,
    operation: request.operation,
    relation: request.relation,
    reasonCode: request.reasonCode,
  });
  const submitted = canonicalPayload({
    runId: run.id,
    associationId: request.associationId,
    operation: request.operation,
    relation: request.relation,
    claimId,
    reasonCode: request.reasonCode,
    actor: request.actor,
    rationale,
  });

  const existing = await db.withClient((client) =>
    findEvidenceActionByIdempotencyKey(client, run.id, key),
  );
  if (existing !== null) {
    assertSamePayload(existing, submitted);
    return { outcome: 'already_recorded', action: existing, revision: existing.resultingRevision };
  }

  const makeId = request.makeId ?? randomUUID;
  const now = request.now ?? (() => new Date());
  const priorRevision = await db.withClient((client) => currentEvidenceRevision(client, run.id));
  try {
    await db.withTransaction(async (tx) => {
      await insertEvidenceAction(tx, {
        id: makeId(),
        evidenceRunId: run.id,
        associationId: request.associationId,
        operation: request.operation,
        relation: request.relation,
        claimId,
        reasonCode: request.reasonCode,
        rationale,
        actor: request.actor,
        priorRevision,
        idempotencyKey: key,
        createdAt: now().toISOString(),
      });
    });
  } catch (error) {
    if (isDatabaseError(error) && error.code === '23505') {
      const winner = await db.withClient((client) =>
        findEvidenceActionByIdempotencyKey(client, run.id, key),
      );
      if (winner !== null) {
        assertSamePayload(winner, submitted);
        return { outcome: 'already_recorded', action: winner, revision: winner.resultingRevision };
      }
      throw configuration(
        'stale_revision',
        'the evidence review revision moved while this decision was being prepared',
      );
    }
    throw error;
  }
  const stored = await db.withClient((client) =>
    findEvidenceActionByIdempotencyKey(client, run.id, key),
  );
  if (stored === null) {
    throw new IngestionError(
      'database',
      'action_not_stored',
      'the evidence decision was not stored',
    );
  }
  return { outcome: 'recorded', action: stored, revision: stored.resultingRevision };
}

/** Count-only review history for one explicit run. */
export async function evidenceReviewCounts(
  db: Database,
  runId: string,
): Promise<{
  readonly actions: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly revision: number;
}> {
  const run = await db.withClient((client) => getEvidenceRun(client, runId));
  if (run === null) throw configuration('evidence_run_not_found', 'no evidence run with that id');
  const actions = await db.withClient((client) => listEvidenceActions(client, run.id));
  return {
    actions: actions.length,
    accepted: actions.filter((action) => action.operation === 'accept').length,
    rejected: actions.filter((action) => action.operation === 'reject').length,
    revision: actions.reduce((highest, action) => Math.max(highest, action.resultingRevision), 0),
  };
}
