import Link from 'next/link';

import {
  ChoiceLinks,
  Csrf,
  FilterBar,
  Instant,
  Notice,
  Origin,
  SectionBlock,
  Text,
} from '../../../../components/ui.tsx';
import { csrfFor, currentPrincipal } from '../../../../server/dal/principal.ts';
import { weekTable } from '../../../../server/dal/read.ts';
import {
  attempt,
  escalate,
  refusedCharacters,
  type SearchParams,
  single,
} from '../../../page-support.ts';
import { selectAction } from './actions.ts';

export const dynamic = 'force-dynamic';

export default async function WeekTablePage({
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
    weekTable(
      runtime,
      principal,
      weekRunId,
      single(query.category),
      single(query.q),
      single(query.sort),
    ),
  );
  if (!result.ok) {
    return <Notice code={escalate(result.error)} characters={refusedCharacters(result.error)} />;
  }
  const view = result.value;
  const token = principal === null ? '' : csrfFor(principal);
  const href = (category: string, sort: string): string =>
    `/week/${view.week.id}?category=${encodeURIComponent(category)}&sort=${encodeURIComponent(sort)}`;
  return (
    <section>
      <h2>
        Sift table for week <span className="mono">{view.week.id}</span>{' '}
        <Origin value={view.week.dataOrigin} />
      </h2>
      <Notice code={single(query.notice)} at={single(query.at)} more={single(query.more)} />
      <p className="small">
        Window <Instant value={view.week.windowStart} /> to <Instant value={view.week.windowEnd} />{' '}
        · publication cutoff <Instant value={view.week.publicationCutoffAt} /> · clustering run{' '}
        <span className="mono">{view.clusteringRunId}</span>
      </p>
      {view.canViewRoundup ? (
        <p className="small">
          <Link
            href={`/week/${view.week.id}/roundup?category=${encodeURIComponent(view.category)}`}
          >
            Round-up for {view.category}
          </Link>
        </p>
      ) : null}
      {view.canViewArticle ? (
        <p className="small">
          <Link
            href={`/week/${view.week.id}/article?category=${encodeURIComponent(view.category)}`}
          >
            Article for {view.category}
          </Link>
        </p>
      ) : null}
      <SectionBlock title="Sift table">
        <table>
          <thead>
            <tr>
              <th>Incident</th>
              <th>Kind</th>
              <th>Reports</th>
              <th>Title (stored text, escaped)</th>
              <th>Posted</th>
              <th>Week</th>
              <th>Selection</th>
              {view.canSelect ? <th>Decide</th> : null}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr key={row.incidentId}>
                <td>
                  <Link
                    href={`/incidents/${row.clusteringRunId}/${row.incidentId}`}
                    className="mono"
                  >
                    {row.incidentId.slice(0, 8)}
                  </Link>
                </td>
                <td>{row.kind}</td>
                <td>{row.memberCount}</td>
                <td>
                  <Text value={row.title} max={200} />
                </td>
                <td>
                  <Instant value={row.postedFrom} />
                  {row.postedTo === row.postedFrom ? null : (
                    <>
                      {' to '}
                      <Instant value={row.postedTo} />
                    </>
                  )}
                </td>
                <td>{row.carried && !row.inWindow ? 'carried' : 'in window'}</td>
                <td>
                  {row.selection === null ? (
                    <span className="small">undecided</span>
                  ) : (
                    <p className="small">
                      {row.selection.state} · {row.selection.by} ·{' '}
                      <Instant value={row.selection.at} /> · revision {row.selection.revision}
                      {row.selection.note === null ? null : (
                        <>
                          {' '}
                          · <Text value={row.selection.note} max={200} />
                        </>
                      )}
                    </p>
                  )}
                </td>
                {view.canSelect ? (
                  <td>
                    <form action={selectAction}>
                      <Csrf token={token} />
                      <input type="hidden" name="weekRunId" value={view.week.id} />
                      <input type="hidden" name="clusteringRunId" value={row.clusteringRunId} />
                      <input type="hidden" name="incidentId" value={row.incidentId} />
                      <input type="hidden" name="category" value={view.category} />
                      <input
                        type="hidden"
                        name="state"
                        value={row.selection?.state === 'selected' ? 'unselected' : 'selected'}
                      />
                      <input
                        type="text"
                        name="note"
                        maxLength={2000}
                        placeholder="note (optional)"
                      />{' '}
                      <button type="submit">
                        {row.selection?.state === 'selected' ? 'Set aside' : 'Select'}
                      </button>
                    </form>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        <FilterBar>
          <ChoiceLinks
            label="Category"
            current={view.category}
            options={view.week.categories.map((category) => ({
              key: category,
              label: category,
              href: href(category, view.sort),
            }))}
          />
          <ChoiceLinks
            label="Sort"
            current={view.sort}
            options={[
              { key: 'posted_desc', label: 'newest', href: href(view.category, 'posted_desc') },
              {
                key: 'members_desc',
                label: 'most reports',
                href: href(view.category, 'members_desc'),
              },
            ]}
          />
          <span>{view.rows.length} incidents shown</span>
          {view.canSearch ? (
            <form method="get" action={`/week/${view.week.id}`}>
              <input type="hidden" name="category" value={view.category} />
              <input type="hidden" name="sort" value={view.sort} />
              <label>
                Search titles{' '}
                <input type="search" name="q" maxLength={200} defaultValue={view.search ?? ''} />
              </label>{' '}
              <button type="submit">Search</button>
            </form>
          ) : null}
        </FilterBar>
      </SectionBlock>
    </section>
  );
}
