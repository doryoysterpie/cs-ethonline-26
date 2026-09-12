import Link from 'next/link';

import { Csrf, Instant, Notice, Origin, Text } from '../../../../../components/ui.tsx';
import { csrfFor, currentPrincipal } from '../../../../../server/dal/principal.ts';
import { incidentDetail } from '../../../../../server/dal/read.ts';
import { attempt, escalate, single, type SearchParams } from '../../../../page-support.ts';
import { mergeAction, splitAction } from './actions.ts';

export const dynamic = 'force-dynamic';

export default async function IncidentDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly clusteringRunId: string; readonly incidentId: string }>;
  readonly searchParams: SearchParams;
}) {
  const { clusteringRunId, incidentId } = await params;
  const query = await searchParams;
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() =>
    incidentDetail(runtime, principal, clusteringRunId, incidentId),
  );
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  const view = result.value;
  const token = principal === null ? '' : csrfFor(principal);
  const showText = view.members.some((member) => member.title !== null);
  return (
    <section>
      <h2>
        Incident <span className="mono">{view.incident.id}</span>{' '}
        <Origin value={view.incident.dataOrigin} />
      </h2>
      <Notice code={single(query.notice)} />
      <p className="small">
        <Link href={`/incidents/${view.run.id}`}>Clustering run {view.run.id.slice(0, 8)}</Link> ·{' '}
        {view.incident.kind} · {view.incident.memberCount} members · reason codes{' '}
        <span className="mono">{view.incident.reasonCodes.join(', ')}</span> · subject{' '}
        <span className="mono">
          {view.incident.subjectChain === null
            ? 'none recorded'
            : `${view.incident.subjectChain}:${view.incident.subjectProtocolSlug}`}
        </span>{' '}
        · review revision {view.reviewRevision} ·{' '}
        {view.isEffective ? 'effective' : 'superseded by a review action'}
      </p>
      {showText ? null : (
        <p className="small">
          Source text is not shown for this role. Identifiers, decisions and provenance are.
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Membership</th>
            <th>Source row</th>
            <th>Row</th>
            <th>Origin</th>
            <th>Decision</th>
            <th>Posted</th>
            {showText ? <th>Title (stored text, escaped)</th> : null}
            {showText ? <th>Publisher</th> : null}
            {showText ? <th>URL (not linked)</th> : null}
          </tr>
        </thead>
        <tbody>
          {view.members.map((member) => (
            <tr key={member.membershipId}>
              <td className="mono">{member.membershipId}</td>
              <td className="mono">{member.sourceRowId.slice(0, 8)}</td>
              <td>{member.rowNumber}</td>
              <td>
                <Origin value={member.dataOrigin} />
              </td>
              <td>{member.decision}</td>
              <td>
                <Instant value={member.postedAt} />
              </td>
              {showText ? (
                <td>
                  <Text value={member.title} />
                </td>
              ) : null}
              {showText ? (
                <td>
                  <Text value={member.publisher} max={80} />
                </td>
              ) : null}
              {showText ? (
                <td className="mono">
                  <Text value={member.url} />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>

      {view.canReview && principal !== null ? (
        <>
          <h3>Merge with other incidents</h3>
          <p className="small">
            Append-only: the machine record is never rewritten. The action is prepared against
            revision {view.reviewRevision}; if the run is reviewed meanwhile the action is refused.
          </p>
          <form className="stack" action={mergeAction}>
            <Csrf token={token} />
            <input type="hidden" name="clusteringRunId" value={view.run.id} />
            <input type="hidden" name="expectedRevision" value={String(view.reviewRevision)} />
            <label>
              Incident identifiers to merge with this one (comma-separated UUIDs)
              <input name="otherIncidentIds" required maxLength={2400} />
            </label>
            <input type="hidden" name="incidentId" value={view.incident.id} />
            <label>
              Reason code
              <input
                name="reasonCode"
                required
                pattern="[a-z][a-z0-9_]{2,63}"
                maxLength={64}
                defaultValue="same_incident"
              />
            </label>
            <label>
              Note (optional, 1 to 280 characters, private to editors)
              <input name="note" maxLength={280} />
            </label>
            <button type="submit">Record merge</button>
          </form>

          <h3>Split memberships out of this incident</h3>
          <form className="stack" action={splitAction}>
            <Csrf token={token} />
            <input type="hidden" name="clusteringRunId" value={view.run.id} />
            <input type="hidden" name="incidentId" value={view.incident.id} />
            <input type="hidden" name="expectedRevision" value={String(view.reviewRevision)} />
            <label>
              Membership identifiers to split out (comma-separated UUIDs; at least one must remain)
              <input name="membershipIds" required maxLength={20000} />
            </label>
            <label>
              Reason code
              <input
                name="reasonCode"
                required
                pattern="[a-z][a-z0-9_]{2,63}"
                maxLength={64}
                defaultValue="distinct_incident"
              />
            </label>
            <label>
              Note (optional, 1 to 280 characters, private to editors)
              <input name="note" maxLength={280} />
            </label>
            <button type="submit">Record split</button>
          </form>
        </>
      ) : null}
    </section>
  );
}
