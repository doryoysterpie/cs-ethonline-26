import Link from 'next/link';

import { Instant, Notice, Origin } from '../../../components/ui.tsx';
import { currentPrincipal } from '../../../server/dal/principal.ts';
import { commandCenter } from '../../../server/dal/read.ts';
import { attempt, escalate } from '../../page-support.ts';

export const dynamic = 'force-dynamic';

export default async function EvidenceRunsPage() {
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() => commandCenter(runtime, principal));
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  return (
    <section>
      <h2>Evidence states</h2>
      <p className="small">Choose an evidence run. There is no implicit latest run.</p>
      <table>
        <thead>
          <tr>
            <th>Evidence run</th>
            <th>Origin</th>
            <th>Status</th>
            <th>Incidents</th>
            <th>Suggestions</th>
            <th>Contradicted</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {result.value.evidenceRuns.map((run) => (
            <tr key={run.id}>
              <td>
                <Link href={`/evidence/${run.id}`} className="mono">
                  {run.id}
                </Link>
              </td>
              <td>
                <Origin value={run.dataOrigin} />
              </td>
              <td>{run.status}</td>
              <td>{run.incidentCount}</td>
              <td>{run.suggestionCount}</td>
              <td className="state-contradicted">{run.contradicted}</td>
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
