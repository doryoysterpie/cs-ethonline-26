import Link from 'next/link';

import { Instant, Notice, Origin } from '../../../components/ui.tsx';
import { currentPrincipal } from '../../../server/dal/principal.ts';
import { commandCenter } from '../../../server/dal/read.ts';
import { attempt, escalate } from '../../page-support.ts';

export const dynamic = 'force-dynamic';

export default async function AnomalyRunsPage() {
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() => commandCenter(runtime, principal));
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  return (
    <section>
      <h2>Anomaly feed</h2>
      <p className="small">
        Choose a Graph signal run. The feed is built from stored signals; nothing is fetched.
      </p>
      <table>
        <thead>
          <tr>
            <th>Signal run</th>
            <th>Origin</th>
            <th>Status</th>
            <th>Gateway host</th>
            <th>Signals</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {result.value.signalRuns.map((run) => (
            <tr key={run.id}>
              <td>
                <Link href={`/anomaly/${run.id}`} className="mono">
                  {run.id}
                </Link>
              </td>
              <td>
                <Origin value={run.dataOrigin} />
              </td>
              <td>{run.status}</td>
              <td className="mono">{run.gatewayHost}</td>
              <td>{run.signalCount}</td>
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
