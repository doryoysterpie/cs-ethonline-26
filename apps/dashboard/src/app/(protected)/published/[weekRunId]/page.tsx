import Link from 'next/link';

import { SafeMarkdown } from '../../../../components/SafeMarkdown.tsx';
import { Csrf, Instant, Notice, Origin, SectionBlock } from '../../../../components/ui.tsx';
import { csrfFor, currentPrincipal } from '../../../../server/dal/principal.ts';
import { publishedOutput } from '../../../../server/dal/readers.ts';
import { attempt, escalate, single, type SearchParams } from '../../../page-support.ts';
import { makeCardAction } from './actions.ts';

export const dynamic = 'force-dynamic';

export default async function PublishedOutputPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly weekRunId: string }>;
  readonly searchParams: SearchParams;
}) {
  const { weekRunId } = await params;
  const query = await searchParams;
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() =>
    publishedOutput(runtime, principal, weekRunId, single(query.category), single(query.output)),
  );
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  const view = result.value;
  const token = principal === null ? '' : csrfFor(principal);
  return (
    <section>
      <h2>
        {view.output === 'roundup' ? 'Round-up' : 'Article'} · {view.category}{' '}
        <Origin value={view.week.dataOrigin} />
      </h2>
      <p className="small">
        Week <Instant value={view.week.windowStart} /> to <Instant value={view.week.windowEnd} /> ·
        revision {view.revision}, published <Instant value={view.publishedAt} /> ·{' '}
        <Link href="/published">all published</Link>
      </p>
      <Notice code={single(query.notice)} />
      <SafeMarkdown markdown={view.markdown} />
      {view.stories.length === 0 ? null : (
        <SectionBlock title="Share a story">
          <p className="small">
            A card is a public page for one story: its headline as published here and its
            publishers&apos; names, nothing else. Anyone with the address can open it; it is never
            indexed. A story has one card, so sharing it again gives the same address.
          </p>
          <table>
            <thead>
              <tr>
                <th>Story</th>
                <th>Card</th>
              </tr>
            </thead>
            <tbody>
              {view.stories.map((story) => (
                <tr key={story.entryIndex}>
                  <td>{story.headline}</td>
                  <td>
                    <form action={makeCardAction} className="inline">
                      <Csrf token={token} />
                      <input type="hidden" name="weekRunId" value={view.week.id} />
                      <input type="hidden" name="category" value={view.category} />
                      <input type="hidden" name="output" value={view.output} />
                      <input type="hidden" name="entryIndex" value={story.entryIndex} />
                      <button type="submit" className="quiet">
                        Make a card
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionBlock>
      )}
    </section>
  );
}
