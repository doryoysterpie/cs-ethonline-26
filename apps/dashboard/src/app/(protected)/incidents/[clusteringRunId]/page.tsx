import Link from 'next/link';

import { Notice, Origin } from '../../../../components/ui.tsx';
import { currentPrincipal } from '../../../../server/dal/principal.ts';
import { incidentExplorer } from '../../../../server/dal/read.ts';
import { attempt, escalate, single, type SearchParams } from '../../../page-support.ts';

export const dynamic = 'force-dynamic';

export default async function IncidentExplorerPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly clusteringRunId: string }>;
  readonly searchParams: SearchParams;
}) {
  const { clusteringRunId } = await params;
  const query = await searchParams;
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() =>
    incidentExplorer(runtime, principal, clusteringRunId, single(query.after)),
  );
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  const view = result.value;
  return (
    <section>
      <h2>
        Clustering run <span className="mono">{view.run.id}</span>{' '}
        <Origin value={view.run.dataOrigin} />
      </h2>
      <Notice code={single(query.notice)} />
      <p className="small">
        {view.run.status} · {view.run.incidentCount} base incidents · review revision{' '}
        {view.reviewRevision} · {view.effectiveIncidents} effective incidents · batch{' '}
        <span className="mono">{view.run.batchId}</span>
      </p>
      <table>
        <thead>
          <tr>
            <th>Incident</th>
            <th>Origin</th>
            <th>Kind</th>
            <th>Members</th>
            <th>Reason codes</th>
            <th>Recorded subject</th>
          </tr>
        </thead>
        <tbody>
          {view.incidents.map((incident) => (
            <tr key={incident.id}>
              <td>
                <Link href={`/incidents/${view.run.id}/${incident.id}`} className="mono">
                  {incident.id}
                </Link>
              </td>
              <td>
                <Origin value={incident.dataOrigin} />
              </td>
              <td>{incident.kind}</td>
              <td>{incident.memberCount}</td>
              <td className="mono">{incident.reasonCodes.join(', ')}</td>
              <td className="mono">
                {incident.subjectChain === null
                  ? '—'
                  : `${incident.subjectChain}:${incident.subjectProtocolSlug}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.nextAfterId === null ? null : (
        <p>
          <Link href={`/incidents/${view.run.id}?after=${view.nextAfterId}`}>Next page</Link>
        </p>
      )}
    </section>
  );
}
