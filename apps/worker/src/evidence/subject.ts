import { randomUUID } from 'node:crypto';

import type { ChainId } from '@cas/contracts';
import {
  getClusteringRun,
  getIncidentSubject,
  insertIncidentSubject,
  isDatabaseError,
  type Database,
  type IncidentSubjectRecord,
} from '@cas/database';

import { IngestionError } from '../editorial/errors.js';

/**
 * Recording which protocol an incident is about.
 *
 * Sprint 5 extracts nothing from text. There is no rule anywhere that reads a
 * headline for the word "Aave" and calls that a chain identity, because such a
 * rule would be exactly the mechanism by which a report becomes a confirmed
 * onchain fact without anyone deciding it should. A subject is recorded here,
 * by a named person, or it does not exist; and an incident with no subject
 * simply never correlates.
 *
 * The recorded slug is the provider-returned identity the Sprint 1 gate
 * validated, so it is comparable with a stored signal by equality rather than
 * by any kind of matching. One subject per incident, append-only: a correction
 * is a schema change and a migration, not an in-place edit of what a person
 * asserted.
 */

export interface RecordSubjectRequest {
  readonly clusteringRunId: string;
  readonly incidentId: string;
  readonly chain: ChainId;
  readonly protocolSlug: string;
  readonly actor: string;
  readonly reasonCode: string;
}

export interface RecordSubjectOutcome {
  readonly outcome: 'recorded' | 'already_recorded';
  readonly subject: IncidentSubjectRecord;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const REASON_CODE = /^[a-z][a-z0-9_]{2,63}$/u;
const ACTOR = /^[a-z][a-z0-9_.:-]{1,63}$/u;

function configuration(code: string, message: string): IngestionError {
  return new IngestionError('configuration', code, message);
}

/** Records one incident's chain and protocol identity. */
export async function recordIncidentSubject(
  db: Database,
  request: RecordSubjectRequest,
  options: {
    readonly now?: (() => Date) | undefined;
    readonly makeId?: (() => string) | undefined;
  } = {},
): Promise<RecordSubjectOutcome> {
  if (!SLUG.test(request.protocolSlug)) {
    throw configuration('protocol_invalid', '--protocol must be a lower-case provider slug');
  }
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

  const existing = await db.withClient((client) =>
    getIncidentSubject(client, clustering.id, request.incidentId),
  );
  if (existing !== null) {
    // A recorded subject is what a person asserted. A second recording that
    // disagrees is a conflict to be surfaced, never an overwrite.
    if (existing.chain !== request.chain || existing.protocolSlug !== request.protocolSlug) {
      throw configuration(
        'subject_conflict',
        'this incident already has a different recorded subject',
      );
    }
    return { outcome: 'already_recorded', subject: existing };
  }

  const now = options.now ?? (() => new Date());
  const makeId = options.makeId ?? randomUUID;
  try {
    await db.withTransaction((tx) =>
      insertIncidentSubject(tx, {
        id: makeId(),
        clusteringRunId: clustering.id,
        batchId: clustering.batchId,
        incidentClusterId: request.incidentId,
        chain: request.chain,
        protocolSlug: request.protocolSlug,
        actor: request.actor,
        reasonCode: request.reasonCode,
        createdAt: now().toISOString(),
      }),
    );
  } catch (error) {
    if (isDatabaseError(error) && error.code === '23503') {
      throw configuration('incident_not_found', 'no incident with that id in this clustering run');
    }
    if (isDatabaseError(error) && error.code === '23505') {
      const winner = await db.withClient((client) =>
        getIncidentSubject(client, clustering.id, request.incidentId),
      );
      if (winner !== null) return { outcome: 'already_recorded', subject: winner };
    }
    throw error;
  }

  const stored = await db.withClient((client) =>
    getIncidentSubject(client, clustering.id, request.incidentId),
  );
  if (stored === null) {
    throw new IngestionError(
      'database',
      'subject_not_stored',
      'the incident subject was not stored',
    );
  }
  return { outcome: 'recorded', subject: stored };
}
