'use server';

import { redirect } from 'next/navigation';

import { mergeIncidentsAction, splitIncidentAction } from '../../../../../server/dal/mutate.ts';
import { assertActionRequest, currentPrincipal } from '../../../../../server/dal/principal.ts';
import { readClosedObject, uuid } from '../../../../../server/input.ts';
import { attempt, noticeCodeFor, withNotice } from '../../../../page-support.ts';

function back(runId: unknown, incidentId: unknown, code: string): never {
  const run = typeof runId === 'string' ? runId : '';
  const incident = typeof incidentId === 'string' ? incidentId : '';
  redirect(
    withNotice(`/incidents/${encodeURIComponent(run)}/${encodeURIComponent(incident)}`, code),
  );
}

export async function mergeAction(form: FormData): Promise<void> {
  let runId: unknown = null;
  let incidentId: unknown = null;
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return 'session_expired';
    await assertActionRequest(principal, form);
    const input = readClosedObject(form, [
      'csrfToken',
      'clusteringRunId',
      'incidentId',
      'otherIncidentIds',
      'reasonCode',
      'note',
      'expectedRevision',
    ]);
    runId = input.clusteringRunId;
    incidentId = input.incidentId;
    const self = uuid(input.incidentId, 'incidentId');
    const others = typeof input.otherIncidentIds === 'string' ? input.otherIncidentIds : '';
    const result = await mergeIncidentsAction(runtime, principal, {
      clusteringRunId: input.clusteringRunId,
      incidentIds: `${self},${others}`,
      reasonCode: input.reasonCode,
      note: input.note,
      expectedRevision: input.expectedRevision,
    });
    return result.outcome === 'recorded' ? 'recorded' : 'already_recorded';
  });
  back(runId, incidentId, outcome.ok ? outcome.value : noticeCodeFor(outcome.error));
}

export async function splitAction(form: FormData): Promise<void> {
  let runId: unknown = null;
  let incidentId: unknown = null;
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return 'session_expired';
    await assertActionRequest(principal, form);
    const input = readClosedObject(form, [
      'csrfToken',
      'clusteringRunId',
      'incidentId',
      'membershipIds',
      'reasonCode',
      'note',
      'expectedRevision',
    ]);
    runId = input.clusteringRunId;
    incidentId = input.incidentId;
    const result = await splitIncidentAction(runtime, principal, {
      clusteringRunId: input.clusteringRunId,
      incidentId: input.incidentId,
      membershipIds: input.membershipIds,
      reasonCode: input.reasonCode,
      note: input.note,
      expectedRevision: input.expectedRevision,
    });
    return result.outcome === 'recorded' ? 'recorded' : 'already_recorded';
  });
  back(runId, incidentId, outcome.ok ? outcome.value : noticeCodeFor(outcome.error));
}
