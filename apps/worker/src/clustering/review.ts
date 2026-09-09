import { createHash, randomUUID } from 'node:crypto';

import {
  countClusteringReview,
  currentReviewRevision,
  findReviewActionByIdempotencyKey,
  getClusteringRun,
  insertReviewAction,
  isDatabaseError,
  listBaseMemberships,
  listReviewActions,
  type ClusteringRunRecord,
  type Database,
  type Queryable,
  type ReviewActionRecord,
} from '@cas/database';

import { IngestionError } from '../editorial/errors.js';
import { assertReviewNote } from './note.js';

/**
 * The human correction layer (decision D22).
 *
 * Merge and split are append-only actions over a completed clustering run.
 * They never rewrite the machine's base output, so the record of what the
 * engine produced stays exactly what it produced. The effective view is a
 * replay of the base memberships plus the accepted actions in revision order,
 * which makes it deterministic, reproducible and attributable.
 *
 * The database supplies the hard guarantees: actions are append-only, one
 * revision number cannot be claimed twice, an action requires a completed run,
 * and an action cannot name a run or batch other than its own.
 */

/** Bounds on how much one action may touch, so a command cannot be a bulk edit. */
export const MAX_MERGE_INCIDENTS = 64;
export const MAX_SPLIT_MEMBERSHIPS = 500;

export interface EffectiveIncident {
  readonly effectiveIncidentId: string;
  /** `base` while untouched, otherwise the action that produced it. */
  readonly origin: 'base' | 'merge' | 'split';
  readonly membershipIds: readonly string[];
  readonly sourceRowIds: readonly string[];
}

export interface EffectiveView {
  readonly run: ClusteringRunRecord;
  readonly revision: number;
  readonly incidents: readonly EffectiveIncident[];
}

export interface ReviewActionOutcome {
  readonly outcome: 'recorded' | 'already_recorded';
  readonly action: ReviewActionRecord;
  readonly revision: number;
}

/**
 * The complete semantic payload of a review action: every field that is
 * persisted or that changes what the action does.
 *
 * Sprint 4 shipped an idempotency identity built from a subset of these, so a
 * replay carrying a different actor or a different note was answered with the
 * original action and the change was concealed (audit finding F3). The subset
 * is still what the stored `idempotency_key` records, because that is the
 * identity of *what was asked for* and it is what the database's uniqueness is
 * on; but a request that matches an existing key is now compared field by
 * field against the action already stored, and any difference is a conflict.
 */
export interface ReviewActionPayload {
  readonly operation: 'merge' | 'split';
  readonly clusteringRunId: string;
  readonly reasonCode: string;
  readonly actor: string;
  /** `null` is absence; an empty string is refused earlier and is not this. */
  readonly note: string | null;
  /** The revision the caller declared, or `null` when it declared none. */
  readonly expectedRevision: number | null;
  readonly incidentIds: readonly string[];
  readonly membershipIds: readonly string[];
}

const PAYLOAD_VERSION = 'cas.clustering.review.v1';

/** Count, then the identifiers lower-cased and ordered by code point. */
function idList(ids: readonly string[]): string {
  const normalized = ids.map((id) => id.toLowerCase()).sort();
  return `${normalized.length}:${normalized.join(',')}`;
}

/**
 * A deterministic, injective encoding of the whole payload.
 *
 * One field per line; the note length-prefixed in UTF-8 bytes so its content
 * cannot imitate a field boundary; identifier lists counted and ordered so a
 * caller's ordering cannot change the identity; absence written as `absent`
 * so it is distinguishable from an empty value. Migration 0007 builds the
 * identical string in SQL and stores its digest as a generated column, and a
 * PostgreSQL test holds the two to the same value.
 */
export function canonicalReviewPayload(payload: ReviewActionPayload): string {
  return [
    PAYLOAD_VERSION,
    `operation:${payload.operation}`,
    `run:${payload.clusteringRunId.toLowerCase()}`,
    `reason:${payload.reasonCode}`,
    `actor:${payload.actor}`,
    payload.note === null
      ? 'note:absent'
      : `note:present:${Buffer.byteLength(payload.note, 'utf8')}:${payload.note}`,
    payload.expectedRevision === null ? 'revision:absent' : `revision:${payload.expectedRevision}`,
    `incidents:${idList(payload.incidentIds)}`,
    `memberships:${idList(payload.membershipIds)}`,
    '',
  ].join('\n');
}

export function reviewPayloadDigest(payload: ReviewActionPayload): string {
  return createHash('sha256').update(canonicalReviewPayload(payload), 'utf8').digest('hex');
}

/** The payload an already-stored action represents. */
export function payloadOfAction(action: ReviewActionRecord): ReviewActionPayload {
  return {
    operation: action.operation,
    clusteringRunId: action.clusteringRunId,
    reasonCode: action.reasonCode,
    actor: action.actor,
    note: action.note,
    expectedRevision: action.expectedRevision,
    incidentIds: action.affectedIncidentIds,
    membershipIds: action.affectedMembershipIds,
  };
}

/**
 * The identity of what was asked for: the operation, the run it addresses, the
 * incidents and memberships it names and the reason given.
 *
 * The revision is deliberately excluded here: replaying the same request after
 * it landed must find the action it already created, and by then the revision
 * has moved on. Actor and note are excluded here too, and are enforced by the
 * payload comparison instead, so that a replay differing only in who asked or
 * what they wrote is refused rather than silently accepted or silently
 * recorded twice.
 */
function actionKey(input: {
  readonly operation: string;
  readonly clusteringRunId: string;
  readonly incidentIds: readonly string[];
  readonly membershipIds: readonly string[];
  readonly reasonCode: string;
}): string {
  // Encoded exactly as the canonical payload encodes the same fields, so the
  // key and the payload agree about identifier order and case. They must: a
  // request whose identifiers differ only in order or case is the same
  // request, and it has to find its own action rather than a new key.
  return createHash('sha256')
    .update(
      [
        PAYLOAD_VERSION,
        `operation:${input.operation}`,
        `run:${input.clusteringRunId.toLowerCase()}`,
        `reason:${input.reasonCode}`,
        `incidents:${idList(input.incidentIds)}`,
        `memberships:${idList(input.membershipIds)}`,
        '',
      ].join('\n'),
      'utf8',
    )
    .digest('hex');
}

async function loadCompletedRun(db: Database, runId: string): Promise<ClusteringRunRecord> {
  const run = await db.withClient((client) => getClusteringRun(client, runId));
  if (run === null) {
    throw new IngestionError(
      'configuration',
      'clustering_run_not_found',
      'no clustering run with that id',
    );
  }
  if (run.status !== 'completed') {
    throw new IngestionError(
      'configuration',
      'clustering_run_not_completed',
      'a review action requires a completed clustering run',
    );
  }
  return run;
}

/** Replays base memberships plus ordered actions into the effective assignment. */
function replay(
  base: readonly { membershipId: string; incidentClusterId: string; sourceRowId: string }[],
  actions: readonly ReviewActionRecord[],
): {
  assignment: Map<string, string>;
  origin: Map<string, 'base' | 'merge' | 'split'>;
  rows: Map<string, string>;
} {
  const assignment = new Map<string, string>();
  const rows = new Map<string, string>();
  const origin = new Map<string, 'base' | 'merge' | 'split'>();
  for (const membership of base) {
    assignment.set(membership.membershipId, membership.incidentClusterId);
    rows.set(membership.membershipId, membership.sourceRowId);
    origin.set(membership.incidentClusterId, 'base');
  }
  for (const action of actions) {
    if (action.operation === 'merge') {
      const targets = new Set(action.affectedIncidentIds);
      for (const [membershipId, incidentId] of assignment) {
        if (targets.has(incidentId)) assignment.set(membershipId, action.id);
      }
      origin.set(action.id, 'merge');
    } else {
      for (const membershipId of action.affectedMembershipIds) {
        if (assignment.has(membershipId)) assignment.set(membershipId, action.id);
      }
      origin.set(action.id, 'split');
    }
  }
  return { assignment, origin, rows };
}

function group(
  assignment: Map<string, string>,
  origin: Map<string, 'base' | 'merge' | 'split'>,
  rows: Map<string, string>,
): EffectiveIncident[] {
  const byIncident = new Map<string, string[]>();
  for (const [membershipId, incidentId] of assignment) {
    const bucket = byIncident.get(incidentId);
    if (bucket === undefined) byIncident.set(incidentId, [membershipId]);
    else bucket.push(membershipId);
  }
  return [...byIncident.keys()].sort().map((incidentId) => {
    const membershipIds = (byIncident.get(incidentId) ?? []).sort();
    return {
      effectiveIncidentId: incidentId,
      origin: origin.get(incidentId) ?? 'base',
      membershipIds,
      sourceRowIds: membershipIds.map((id) => rows.get(id) ?? '').sort(),
    };
  });
}

/** The deterministic effective view of one completed clustering run. */
export async function effectiveIncidents(db: Database, runId: string): Promise<EffectiveView> {
  const run = await loadCompletedRun(db, runId);
  return db.withClient(async (client) => {
    const base = await listBaseMemberships(client, runId);
    const actions = await listReviewActions(client, runId);
    const replayed = replay(base, actions);
    return {
      run,
      revision: actions.length === 0 ? 0 : (actions[actions.length - 1]?.resultingRevision ?? 0),
      incidents: group(replayed.assignment, replayed.origin, replayed.rows),
    };
  });
}

interface ActionRequest {
  readonly runId: string;
  readonly reasonCode: string;
  readonly actor: string;
  readonly note?: string | null | undefined;
  /**
   * The revision the caller believes it is acting on. Optional: when it is
   * omitted the current revision stands and nothing is declared, which is what
   * the command line does. When it is given it must match, and it becomes part
   * of the action's identity, so a replay declaring a different revision is a
   * conflict rather than a repeat.
   */
  readonly expectedRevision?: number | undefined;
  readonly makeId?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
}

async function record(
  db: Database,
  run: ClusteringRunRecord,
  request: ActionRequest,
  operation: 'merge' | 'split',
  incidentIds: readonly string[],
  membershipIds: readonly string[],
  priorRevision: number,
  idempotencyKey: string,
  submitted: ReviewActionPayload,
): Promise<ReviewActionOutcome> {
  const makeId = request.makeId ?? randomUUID;
  const now = request.now ?? (() => new Date());
  const id = makeId();
  try {
    await db.withTransaction(async (tx: Queryable) => {
      // Re-read the revision inside the transaction; the unique key on
      // (run, resulting_revision) is what actually decides the race.
      const current = await currentReviewRevision(tx, run.id);
      if (current !== priorRevision) {
        throw new IngestionError(
          'configuration',
          'stale_revision',
          'the clustering review revision moved while this action was being prepared',
        );
      }
      await insertReviewAction(tx, {
        id,
        clusteringRunId: run.id,
        batchId: run.batchId,
        operation,
        reasonCode: request.reasonCode,
        note: assertReviewNote(request.note),
        actor: request.actor,
        priorRevision,
        expectedRevision: request.expectedRevision ?? null,
        idempotencyKey,
        affectedIncidentIds: incidentIds,
        affectedMembershipIds: membershipIds,
        createdAt: now().toISOString(),
      });
    });
  } catch (error) {
    if (isDatabaseError(error) && error.code === '23505') {
      // Two writers raced for one identity. The winner is only this request's
      // own action if it carries the same payload; otherwise it is a different
      // action wearing the same key, which is a conflict and not a repeat.
      const winner = await db.withClient((client) =>
        findReviewActionByIdempotencyKey(client, run.id, idempotencyKey),
      );
      if (winner !== null) {
        assertSamePayload(winner, submitted);
        return { outcome: 'already_recorded', action: winner, revision: winner.resultingRevision };
      }
      throw new IngestionError(
        'configuration',
        'stale_revision',
        'the clustering review revision moved while this action was being prepared',
      );
    }
    throw error;
  }
  const stored = await db.withClient((client) =>
    findReviewActionByIdempotencyKey(client, run.id, idempotencyKey),
  );
  if (stored === null) {
    throw new IngestionError('database', 'action_not_stored', 'the review action was not stored');
  }
  return { outcome: 'recorded', action: stored, revision: stored.resultingRevision };
}

function configuration(code: string, message: string): IngestionError {
  return new IngestionError('configuration', code, message);
}

/**
 * Refuses a request that reuses an existing action's identity while differing
 * anywhere in its payload.
 *
 * The message names the condition alone. It does not echo the actor, the note,
 * the reason, any identifier or any difference between the two payloads,
 * because the caller supplying the second payload is not entitled to read the
 * first.
 */
function assertSamePayload(stored: ReviewActionRecord, submitted: ReviewActionPayload): void {
  if (canonicalReviewPayload(payloadOfAction(stored)) === canonicalReviewPayload(submitted)) {
    return;
  }
  throw new IngestionError(
    'configuration',
    'review_action_conflict',
    'a review action with this identity was already recorded with a different payload',
  );
}

/**
 * Looks for an action this request already produced. Checked before the
 * effective view is validated, because once the action landed the incidents it
 * named are no longer effective and validation would refuse its own replay.
 *
 * An exact replay returns the original action. A replay that changed any
 * semantic field fails, writes nothing and does not return the earlier action.
 */
async function alreadyRecorded(
  db: Database,
  runId: string,
  idempotencyKey: string,
  submitted: ReviewActionPayload,
): Promise<ReviewActionOutcome | null> {
  const found = await db.withClient((client) =>
    findReviewActionByIdempotencyKey(client, runId, idempotencyKey),
  );
  if (found === null) return null;
  assertSamePayload(found, submitted);
  return { outcome: 'already_recorded', action: found, revision: found.resultingRevision };
}

/**
 * A declared revision that no longer matches is stale, not a conflict: the
 * caller asked to act on a state that has moved, and nothing with that
 * identity was ever recorded.
 */
function assertDeclaredRevision(declared: number | null, current: number): void {
  if (declared !== null && declared !== current) {
    throw configuration(
      'stale_revision',
      'the clustering review revision moved while this action was being prepared',
    );
  }
}

/** A declared revision must be a whole, non-negative number if it is given. */
function assertExpectedRevision(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw configuration(
      'expected_revision_invalid',
      'the declared clustering review revision must be a whole number of zero or more',
    );
  }
  return value;
}

/** Merges two or more effective incidents of one run into a new effective incident. */
export async function mergeIncidents(
  db: Database,
  request: ActionRequest & { readonly incidentIds: readonly string[] },
): Promise<ReviewActionOutcome> {
  // Validated before anything is hashed, stored or looked up, so a refused
  // note never reaches a digest, a database round trip or a printed line.
  const note = assertReviewNote(request.note);
  const expectedRevision = assertExpectedRevision(request.expectedRevision);
  const run = await loadCompletedRun(db, request.runId);
  const unique = [...new Set(request.incidentIds)].sort();
  if (unique.length !== request.incidentIds.length) {
    throw configuration('incident_repeated', 'an incident may be named only once in a merge');
  }
  if (unique.length < 2) {
    throw configuration('merge_needs_two', 'a merge needs at least two distinct incidents');
  }
  if (unique.length > MAX_MERGE_INCIDENTS) {
    throw configuration('merge_too_large', 'a merge may not name more incidents than the bound');
  }
  const key = actionKey({
    operation: 'merge',
    clusteringRunId: run.id,
    incidentIds: unique,
    membershipIds: [],
    reasonCode: request.reasonCode,
  });
  const submitted: ReviewActionPayload = {
    operation: 'merge',
    clusteringRunId: run.id,
    reasonCode: request.reasonCode,
    actor: request.actor,
    note,
    expectedRevision,
    incidentIds: unique,
    membershipIds: [],
  };
  const replayed = await alreadyRecorded(db, run.id, key, submitted);
  if (replayed !== null) return replayed;
  const view = await effectiveIncidents(db, request.runId);
  assertDeclaredRevision(expectedRevision, view.revision);
  const known = new Set(view.incidents.map((incident) => incident.effectiveIncidentId));
  for (const id of unique) {
    if (!known.has(id)) {
      throw configuration(
        'incident_not_effective',
        'an incident named in the merge is not a current effective incident of this run',
      );
    }
  }
  return record(db, run, request, 'merge', unique, [], view.revision, key, submitted);
}

/** Splits selected memberships out of one effective incident into a new one. */
export async function splitIncident(
  db: Database,
  request: ActionRequest & {
    readonly incidentId: string;
    readonly membershipIds: readonly string[];
  },
): Promise<ReviewActionOutcome> {
  const note = assertReviewNote(request.note);
  const expectedRevision = assertExpectedRevision(request.expectedRevision);
  const run = await loadCompletedRun(db, request.runId);
  const unique = [...new Set(request.membershipIds)].sort();
  if (unique.length !== request.membershipIds.length) {
    throw configuration('membership_repeated', 'a membership may be named only once in a split');
  }
  if (unique.length === 0) throw configuration('split_needs_member', 'a split needs a membership');
  if (unique.length > MAX_SPLIT_MEMBERSHIPS) {
    throw configuration('split_too_large', 'a split may not name more memberships than the bound');
  }
  const key = actionKey({
    operation: 'split',
    clusteringRunId: run.id,
    incidentIds: [request.incidentId],
    membershipIds: unique,
    reasonCode: request.reasonCode,
  });
  const submitted: ReviewActionPayload = {
    operation: 'split',
    clusteringRunId: run.id,
    reasonCode: request.reasonCode,
    actor: request.actor,
    note,
    expectedRevision,
    incidentIds: [request.incidentId],
    membershipIds: unique,
  };
  const replayed = await alreadyRecorded(db, run.id, key, submitted);
  if (replayed !== null) return replayed;
  const view = await effectiveIncidents(db, request.runId);
  assertDeclaredRevision(expectedRevision, view.revision);
  const incident = view.incidents.find(
    (candidate) => candidate.effectiveIncidentId === request.incidentId,
  );
  if (incident === undefined) {
    throw configuration(
      'incident_not_effective',
      'the incident named in the split is not a current effective incident of this run',
    );
  }
  const members = new Set(incident.membershipIds);
  for (const id of unique) {
    if (!members.has(id)) {
      throw configuration(
        'membership_not_in_incident',
        'a membership named in the split does not belong to that incident',
      );
    }
  }
  if (unique.length >= incident.membershipIds.length) {
    throw configuration(
      'split_takes_everything',
      'a split must leave at least one membership behind',
    );
  }
  return record(
    db,
    run,
    request,
    'split',
    [request.incidentId],
    unique,
    view.revision,
    key,
    submitted,
  );
}

export interface ReviewCounts {
  readonly run: ClusteringRunRecord;
  readonly revision: number;
  readonly actions: number;
  readonly ambiguousLinks: number;
  readonly reviewMemberships: number;
  readonly effectiveIncidents: number;
}

/** Count-only review workload for one explicit run. */
export async function reviewCounts(db: Database, runId: string): Promise<ReviewCounts> {
  const view = await effectiveIncidents(db, runId);
  return db.withClient(async (client) => {
    const counts = await countClusteringReview(client, runId);
    const actions = await listReviewActions(client, runId);
    return {
      run: view.run,
      revision: view.revision,
      actions: actions.length,
      ambiguousLinks: counts.ambiguousLinks,
      reviewMemberships: counts.reviewMemberships,
      effectiveIncidents: view.incidents.length,
    };
  });
}
