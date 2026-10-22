import Link from 'next/link';

import { Instant, Notice, Origin } from '../../../components/ui.tsx';
import { currentPrincipal } from '../../../server/dal/principal.ts';
import { publishedList } from '../../../server/dal/readers.ts';
import { attempt, escalate } from '../../page-support.ts';

export const dynamic = 'force-dynamic';

export default async function PublishedPage() {
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() => publishedList(runtime, principal));
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  const entries = result.value;
  return (
    <section>
      <h2>Published</h2>
      <p className="small">
        The round-ups and articles the owner has published, newest first. Each page shows the
        revision the owner marked, and nothing else.
      </p>
      {entries.length === 0 ? (
        <p>Nothing is published yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Week</th>
              <th>Category</th>
              <th>Output</th>
              <th>Published</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={`${entry.week.id}-${entry.category}-${entry.output}`}>
                <td>
                  <Instant value={entry.week.windowStart} /> to{' '}
                  <Instant value={entry.week.windowEnd} /> <Origin value={entry.week.dataOrigin} />
                </td>
                <td>{entry.category}</td>
                <td>
                  <Link
                    href={`/published/${entry.week.id}?category=${encodeURIComponent(entry.category)}&output=${entry.output}`}
                  >
                    {entry.output === 'roundup' ? 'Round-up' : 'Article'}
                  </Link>
                </td>
                <td>
                  <Instant value={entry.publishedAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
