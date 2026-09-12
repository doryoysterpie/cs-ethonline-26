'use server';

import { redirect } from 'next/navigation';

import { decideEvidence } from '../../../../server/dal/mutate.ts';
import { assertActionRequest, currentPrincipal } from '../../../../server/dal/principal.ts';
import { readClosedObject } from '../../../../server/input.ts';
import { attempt, noticeCodeFor, withNotice } from '../../../page-support.ts';

export async function decideAction(form: FormData): Promise<void> {
  let runId: unknown = null;
  const outcome = await attempt(async () => {
    const { runtime, principal } = await currentPrincipal();
    if (principal === null) return 'session_expired';
    await assertActionRequest(principal, form);
    const input = readClosedObject(form, [
      'csrfToken',
      'evidenceRunId',
      'associationId',
      'operation',
      'relation',
      'claimId',
      'reasonCode',
      'rationale',
    ]);
    runId = input.evidenceRunId;
    const result = await decideEvidence(runtime, principal, {
      evidenceRunId: input.evidenceRunId,
      associationId: input.associationId,
      operation: input.operation,
      relation: input.relation,
      claimId: input.claimId,
      reasonCode: input.reasonCode,
      rationale: input.rationale,
    });
    return result.outcome === 'recorded' ? 'recorded' : 'already_recorded';
  });
  const run = typeof runId === 'string' ? runId : '';
  redirect(
    withNotice(
      `/evidence/${encodeURIComponent(run)}`,
      outcome.ok ? outcome.value : noticeCodeFor(outcome.error),
    ),
  );
}
