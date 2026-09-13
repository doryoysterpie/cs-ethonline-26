import Link from 'next/link';

import { Csrf, Instant, Limitation, Notice, Origin, Text } from '../../../../components/ui.tsx';
import { csrfFor, currentPrincipal } from '../../../../server/dal/principal.ts';
import { evidenceView } from '../../../../server/dal/read.ts';
import { attempt, escalate, single, type SearchParams } from '../../../page-support.ts';
import { decideAction } from './actions.ts';

export const dynamic = 'force-dynamic';

export default async function EvidencePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly evidenceRunId: string }>;
  readonly searchParams: SearchParams;
}) {
  const { evidenceRunId } = await params;
  const query = await searchParams;
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() => evidenceView(runtime, principal, evidenceRunId));
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  const view = result.value;
  const token = principal === null ? '' : csrfFor(principal);
  return (
    <section>
      <h2>
        Evidence run <span className="mono">{view.run.id}</span>{' '}
        <Origin value={view.run.dataOrigin} />
      </h2>
      <Notice code={single(query.notice)} />
      <p className="small">
        {view.run.status} · clustering run{' '}
        <Link href={`/incidents/${view.run.clusteringRunId}`} className="mono">
          {view.run.clusteringRunId.slice(0, 8)}
        </Link>{' '}
        · signal run{' '}
        <Link href={`/anomaly/${view.run.signalRunId}`} className="mono">
          {view.run.signalRunId.slice(0, 8)}
        </Link>{' '}
        · review revision {view.revision}
      </p>
      {view.limitations.map((sentence) => (
        <Limitation key={sentence}>{sentence}</Limitation>
      ))}
      <table>
        <thead>
          <tr>
            <th>Incidents</th>
            <th>Suggestions</th>
            <th>Reported only</th>
            <th>On-chain observed</th>
            <th>Corroborated</th>
            <th>Contradicted</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{view.run.counts.incidents}</td>
            <td>{view.run.counts.suggestions}</td>
            <td>{view.run.counts.reportedOnly}</td>
            <td>{view.run.counts.onchainObserved}</td>
            <td className="state-corroborated">{view.run.counts.corroborated}</td>
            <td className="state-contradicted">{view.run.counts.contradicted}</td>
          </tr>
        </tbody>
      </table>

      <h3>Resolved states</h3>
      <table>
        <thead>
          <tr>
            <th>Incident</th>
            <th>State</th>
            <th>Reason code</th>
            <th>Claim</th>
            <th>Accepted associations</th>
            <th>Subject recorded</th>
          </tr>
        </thead>
        <tbody>
          {view.states.map((state) => (
            <tr key={state.incidentId}>
              <td>
                <Link
                  href={`/incidents/${view.run.clusteringRunId}/${state.incidentId}`}
                  className="mono"
                >
                  {state.incidentId.slice(0, 8)}
                </Link>
              </td>
              <td className={`state-${state.state}`}>{state.state}</td>
              <td className="mono">{state.reasonCode}</td>
              <td className="mono">{state.claimId ?? '—'}</td>
              <td>{state.acceptedAssociationCount}</td>
              <td>{state.hasSubject ? 'yes' : 'no'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Associations (machine suggestions and their effective status)</h3>
      <table>
        <thead>
          <tr>
            <th>Association</th>
            <th>Incident</th>
            <th>Signal</th>
            <th>Observed</th>
            <th>Delta %</th>
            <th>Offset (s)</th>
            <th>Reason codes</th>
            <th>Suggested</th>
            <th>Effective</th>
            {view.canReview ? <th>Decide</th> : null}
          </tr>
        </thead>
        <tbody>
          {view.associations.map((association) => (
            <tr key={association.associationId}>
              <td className="mono">{association.associationId.slice(0, 8)}</td>
              <td className="mono">{association.incidentId.slice(0, 8)}</td>
              <td className="mono">
                {association.chain}:{association.protocolSlug}
              </td>
              <td>
                <Instant value={association.observedAt} />
              </td>
              <td className="mono">{association.deltaPercent}</td>
              <td>{association.offsetSeconds}</td>
              <td className="mono">{association.reasonCodes.join(', ')}</td>
              <td>{association.suggestedRelation}</td>
              <td>
                {association.effectiveStatus} / {association.effectiveRelation}
                {association.effectiveClaimId === null
                  ? ''
                  : ` / claim ${association.effectiveClaimId.slice(0, 8)}`}
              </td>
              {view.canReview ? (
                <td>
                  <form action={decideAction} className="stack">
                    <Csrf token={token} />
                    <input type="hidden" name="evidenceRunId" value={view.run.id} />
                    <input type="hidden" name="associationId" value={association.associationId} />
                    <label>
                      Operation
                      <select name="operation" defaultValue="accept">
                        <option value="accept">accept</option>
                        <option value="reject">reject</option>
                      </select>
                    </label>
                    <label>
                      Relation
                      <select name="relation" defaultValue="context">
                        <option value="context">context</option>
                        <option value="supports">supports</option>
                        <option value="conflicts">conflicts</option>
                      </select>
                    </label>
                    <label>
                      Claim (UUID; required for supports or conflicts)
                      <input name="claimId" maxLength={36} />
                    </label>
                    <label>
                      Reason code
                      <input
                        name="reasonCode"
                        required
                        pattern="[a-z][a-z0-9_]{2,63}"
                        maxLength={64}
                        defaultValue="editorial_review"
                      />
                    </label>
                    <label>
                      Rationale (optional, private to editors)
                      <input name="rationale" maxLength={280} />
                    </label>
                    <button type="submit">Record decision</button>
                  </form>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Decisions (append-only)</h3>
      <table>
        <thead>
          <tr>
            <th>Revision</th>
            <th>Association</th>
            <th>Operation</th>
            <th>Relation</th>
            <th>Reason code</th>
            <th>Actor</th>
            <th>Recorded</th>
            <th>Rationale</th>
          </tr>
        </thead>
        <tbody>
          {view.decisions.map((decision) => (
            <tr key={`${decision.associationId}:${decision.resultingRevision}`}>
              <td>{decision.resultingRevision}</td>
              <td className="mono">{decision.associationId.slice(0, 8)}</td>
              <td>{decision.operation}</td>
              <td>{decision.relation}</td>
              <td className="mono">{decision.reasonCode}</td>
              <td className="mono">{decision.actor}</td>
              <td>
                <Instant value={decision.createdAt} />
              </td>
              <td>
                {decision.rationale === null ? (
                  <span className="small">not shown</span>
                ) : (
                  <Text value={decision.rationale} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
