import Link from 'next/link';

import { Instant, Notice, Origin, SectionBlock } from '../../../components/ui.tsx';
import { requireCapability } from '../../../server/dal/guard.ts';
import { currentPrincipal } from '../../../server/dal/principal.ts';
import { commandCenter } from '../../../server/dal/read.ts';
import { attempt, escalate, single, type SearchParams } from '../../page-support.ts';

export const dynamic = 'force-dynamic';

export default async function QueueRunsPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const query = await searchParams;
  // The filter is compared, never echoed: a category name reaches the page
  // only from the database, where a check constraint bounds its alphabet.
  const filter = single(query.category);
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(async () => {
    requireCapability(principal, 'view:queue');
    return commandCenter(runtime, principal);
  });
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  const runs = result.value.classificationRuns;
  const categories = [
    ...new Set(runs.map((run) => run.category).filter((c): c is string => c !== null)),
  ].sort();
  const shown = filter === undefined ? runs : runs.filter((run) => run.category === filter);
  return (
    <section>
      <h2>Review queue</h2>
      <p className="small">
        The needs-review queue is derived from an explicit classification run. A decision recorded
        here is a human <span className="mono">ReviewState</span>, kept apart from the
        machine&apos;s <span className="mono">ClassificationDecision</span>. A run answers one
        category&apos;s question, so one queue shows one category.
      </p>
      <p className="small">
        Category: <Link href="/queue">all</Link>
        {categories.map((category) => (
          <span key={category}>
            {' · '}
            <Link href={`/queue?category=${encodeURIComponent(category)}`}>{category}</Link>
          </span>
        ))}
      </p>
      {shown.length === 0 && filter !== undefined ? (
        <p className="small">No listed run carries that category.</p>
      ) : null}
      <SectionBlock title="Classification runs">
        <table>
          <thead>
            <tr>
              <th>Classification run</th>
              <th>Category</th>
              <th>Origin</th>
              <th>Batch</th>
              <th>Needs review</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((run) => (
              <tr key={run.id}>
                <td>
                  <Link href={`/queue/${run.id}`} className="mono">
                    {run.id}
                  </Link>
                </td>
                <td>{run.category ?? <span className="small">none recorded</span>}</td>
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
      </SectionBlock>
    </section>
  );
}
