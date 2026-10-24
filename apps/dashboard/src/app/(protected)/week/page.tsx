import Link from 'next/link';

import { Instant, Notice, Origin, SectionBlock } from '../../../components/ui.tsx';
import { currentPrincipal } from '../../../server/dal/principal.ts';
import { weekList } from '../../../server/dal/read.ts';
import { attempt, escalate } from '../../page-support.ts';

export const dynamic = 'force-dynamic';

export default async function WeekListPage() {
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() => weekList(runtime, principal));
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  return (
    <section>
      <h2>Editorial weeks</h2>
      <p className="small">
        One row per week run: the window (D10, Saturday 23:59 to Saturday 23:59 in the editorial
        zone), the batch it ran over, the categories it covered and its status. A failed run stays
        as history; the sift table opens on a completed one.
      </p>
      <SectionBlock title="Week runs">
        <table>
          <thead>
            <tr>
              <th>Week run</th>
              <th>Window</th>
              <th>Categories</th>
              <th>Origin</th>
              <th>Status</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {result.value.weeks.map((week) => (
              <tr key={week.id}>
                <td>
                  {week.status === 'completed' ? (
                    <Link href={`/week/${week.id}`} className="mono">
                      {week.id}
                    </Link>
                  ) : (
                    <span className="mono">{week.id}</span>
                  )}
                </td>
                <td>
                  <Instant value={week.windowStart} /> to <Instant value={week.windowEnd} />
                </td>
                <td>{week.categories.join(', ')}</td>
                <td>
                  <Origin value={week.dataOrigin} />
                </td>
                <td>
                  {week.status}
                  {week.failureCode === null ? null : (
                    <span className="mono"> {week.failureCode}</span>
                  )}
                </td>
                <td>
                  <Instant value={week.startedAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionBlock>
    </section>
  );
}
