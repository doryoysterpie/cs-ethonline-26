import Link from 'next/link';

import { Instant, Notice, Origin } from '../../../components/ui.tsx';
import { currentPrincipal } from '../../../server/dal/principal.ts';
import { commandCenter } from '../../../server/dal/read.ts';
import { attempt, escalate } from '../../page-support.ts';

export const dynamic = 'force-dynamic';

export default async function IncidentRunsPage() {
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() => commandCenter(runtime, principal));
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  return (
    <section>
      <h2>Incident explorer</h2>
      <p className="small">Choose a clustering run. There is no implicit latest run.</p>
      <table>
        <thead>
          <tr>
            <th>Clustering run</th>
            <th>Origin</th>
            <th>Status</th>
            <th>Incidents</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {result.value.clusteringRuns.map((run) => (
            <tr key={run.id}>
              <td>
                <Link href={`/incidents/${run.id}`} className="mono">
                  {run.id}
                </Link>
              </td>
              <td>
                <Origin value={run.dataOrigin} />
              </td>
              <td>{run.status}</td>
              <td>{run.incidentCount}</td>
              <td>
                <Instant value={run.startedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
