import Link from 'next/link';

import { Instant, Notice, Origin } from '../../../components/ui.tsx';
import { requireCapability } from '../../../server/dal/guard.ts';
import { currentPrincipal } from '../../../server/dal/principal.ts';
import { commandCenter } from '../../../server/dal/read.ts';
import { attempt, escalate } from '../../page-support.ts';

export const dynamic = 'force-dynamic';

export default async function QueueRunsPage() {
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(async () => {
    requireCapability(principal, 'view:queue');
    return commandCenter(runtime, principal);
  });
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  return (
    <section>
      <h2>Review queue</h2>
      <p className="small">
        The needs-review queue is derived from an explicit classification run. A decision recorded
        here is a human <span className="mono">ReviewState</span>, kept apart from the
        machine&apos;s <span className="mono">ClassificationDecision</span>.
      </p>
      <table>
        <thead>
          <tr>
            <th>Classification run</th>
            <th>Origin</th>
            <th>Batch</th>
            <th>Needs review</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {result.value.classificationRuns.map((run) => (
            <tr key={run.id}>
              <td>
                <Link href={`/queue/${run.id}`} className="mono">
                  {run.id}
                </Link>
              </td>
              <td>
                <Origin value={run.dataOrigin} />
              </td>
              <td className="mono">{run.batchId.slice(0, 8)}</td>
              <td>{run.reviewCount}</td>
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
