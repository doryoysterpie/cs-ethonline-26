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
 * The identity of an action is what it does, not when it was asked for. The
 * revision is deliberately excluded: replaying the same request after it
 * landed must find the action it already created, and by then the revision has
 * moved on. Nothing is lost, because after a merge the incidents it consumed
 * are no longer effective incidents, so the same request cannot legitimately
 * describe a second, different action.
 */
function actionKey(input: {
  readonly operation: string;
  readonly clusteringRunId: string;
  readonly incidentIds: readonly string[];
  readonly membershipIds: readonly string[];
  readonly reasonCode: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        operation: input.operation,
        clusteringRunId: input.clusteringRunId,
        incidentIds: [...input.incidentIds].sort(),
        membershipIds: [...input.membershipIds].sort(),
        reasonCode: input.reasonCode,
      }),
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
        note: request.note ?? null,
        actor: request.actor,
        priorRevision,
        idempotencyKey,
        affectedIncidentIds: incidentIds,
        affectedMembershipIds: membershipIds,
        createdAt: now().toISOString(),
      });
    });
  } catch (error) {
    if (isDatabaseError(error) && error.code === '23505') {
      const winner = await db.withClient((client) =>
        findReviewActionByIdempotencyKey(client, run.id, idempotencyKey),
      );
      if (winner !== null) {
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
 * Looks for an action this request already produced. Checked before the
 * effective view is validated, because once the action landed the incidents it
 * named are no longer effective and validation would refuse its own replay.
 */
async function alreadyRecorded(
  db: Database,
  runId: string,
  idempotencyKey: string,
): Promise<ReviewActionOutcome | null> {
  const found = await db.withClient((client) =>
    findReviewActionByIdempotencyKey(client, runId, idempotencyKey),
  );
  return found === null
    ? null
    : { outcome: 'already_recorded', action: found, revision: found.resultingRevision };
}

/** Merges two or more effective incidents of one run into a new effective incident. */
export async function mergeIncidents(
  db: Database,
  request: ActionRequest & { readonly incidentIds: readonly string[] },
): Promise<ReviewActionOutcome> {
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
  const replayed = await alreadyRecorded(db, run.id, key);
  if (replayed !== null) return replayed;
  const view = await effectiveIncidents(db, request.runId);
  const known = new Set(view.incidents.map((incident) => incident.effectiveIncidentId));
  for (const id of unique) {
    if (!known.has(id)) {
      throw configuration(
        'incident_not_effective',
        'an incident named in the merge is not a current effective incident of this run',
      );
    }
  }
  return record(db, run, request, 'merge', unique, [], view.revision, key);
}

/** Splits selected memberships out of one effective incident into a new one. */
export async function splitIncident(
  db: Database,
  request: ActionRequest & {
    readonly incidentId: string;
    readonly membershipIds: readonly string[];
  },
): Promise<ReviewActionOutcome> {
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
  const replayed = await alreadyRecorded(db, run.id, key);
  if (replayed !== null) return replayed;
  const view = await effectiveIncidents(db, request.runId);
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
  return record(db, run, request, 'split', [request.incidentId], unique, view.revision, key);
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
