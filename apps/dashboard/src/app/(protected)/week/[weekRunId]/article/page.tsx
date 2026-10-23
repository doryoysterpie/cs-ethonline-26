import Link from 'next/link';

import { Csrf, Instant, Notice, Origin } from '../../../../../components/ui.tsx';
import { csrfFor, currentPrincipal } from '../../../../../server/dal/principal.ts';
import { articleView } from '../../../../../server/dal/read.ts';
import { attempt, escalate, single, type SearchParams } from '../../../../page-support.ts';
import { publishAction, unpublishAction } from '../publish-actions.ts';
import { generateArticleAction, readSourcesAction, saveArticleAction } from './actions.ts';

export const dynamic = 'force-dynamic';

function dollars(microdollars: number): string {
  return `USD ${(microdollars / 1_000_000).toFixed(4)}`;
}

export default async function ArticlePage({
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
    articleView(runtime, principal, weekRunId, single(query.category)),
  );
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  const view = result.value;
  const token = principal === null ? '' : csrfFor(principal);
  return (
    <section>
      <h2>
        Article for week <span className="mono">{view.week.id}</span> · {view.category}{' '}
        <Origin value={view.week.dataOrigin} />
      </h2>
      <Notice code={single(query.notice)} />
      <p className="small">
        Window <Instant value={view.week.windowStart} /> to <Instant value={view.week.windowEnd} />{' '}
        · {view.selectedIncidents} incidents, {view.selectedSources} sources selected · article
        spend this month {dollars(view.spendThisMonthMicrodollars)} of{' '}
        {dollars(view.capMicrodollars)} ·{' '}
        <Link href={`/week/${view.week.id}?category=${encodeURIComponent(view.category)}`}>
          back to the sift table
        </Link>
      </p>
      {view.canRead ? (
        view.readerConfigured ? (
          <form action={readSourcesAction}>
            <Csrf token={token} />
            <input type="hidden" name="weekRunId" value={view.week.id} />
            <input type="hidden" name="category" value={view.category} />
            <p className="small">
              Reading fetches each selected source’s page under the fetch policy (only those URLs,
              no redirect followed unchecked, bounded in size and time, robots.txt obeyed) and holds
              the text in memory for ten minutes. Nothing is sent to the model yet.
            </p>
            <button type="submit" disabled={view.selectedSources === 0}>
              {view.reading === null ? 'Read sources' : 'Read sources again'}
            </button>
          </form>
        ) : (
          <p className="small">
            The dashboard has no public address configured; sources cannot be read.
          </p>
        )
      ) : null}
      {view.reading === null ? null : (
        <>
          <h3>Reading, pending your confirmation</h3>
          <p className="small">
            {view.reading.read} read in full, {view.reading.partlyRead} partly,{' '}
            {view.reading.notRead.length} not read · {view.reading.bytes} bytes,{' '}
            {view.reading.chars} characters of text · expires{' '}
            <Instant value={view.reading.expiresAt} />
          </p>
          {view.reading.notRead.length > 0 ? (
            <>
              <p>Not read, and never cited:</p>
              <ul>
                {view.reading.notRead.map((entry, index) => (
                  <li key={index}>
                    <span className="mono">{entry.publisher}</span> · {entry.code}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {view.reading.partly.length > 0 ? (
            <>
              <p>Partly read, cut at the bound:</p>
              <ul>
                {view.reading.partly.map((entry, index) => (
                  <li key={index}>
                    <span className="mono">{entry.publisher}</span> · {entry.code}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {view.canGenerate ? (
            view.modelConfigured ? (
              <form action={generateArticleAction}>
                <Csrf token={token} />
                <input type="hidden" name="weekRunId" value={view.week.id} />
                <input type="hidden" name="category" value={view.category} />
                <input type="hidden" name="readingId" value={view.reading.readingId} />
                <p className="small">
                  Writing sends the selected stories’ recorded fields and the texts read, and
                  nothing else, to the model named in D9, once, and records revision 1 with the
                  token counts, the cost, the word count and the reading record.
                </p>
                <button type="submit" disabled={view.reading.read + view.reading.partlyRead === 0}>
                  Write the article from {view.reading.read + view.reading.partlyRead} sources
                </button>
              </form>
            ) : (
              <p className="small">No model credential is configured; writing is unavailable.</p>
            )
          ) : null}
        </>
      )}
      {view.revisions.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Revision</th>
              <th>Kind</th>
              <th>By</th>
              <th>At</th>
              <th>Model</th>
              <th>Tokens in / out</th>
              <th>Cost</th>
              <th>Words</th>
              <th>Naming</th>
              <th>Sources read / partly / not</th>
              <th>Readers</th>
            </tr>
          </thead>
          <tbody>
            {view.revisions.map((revision) => (
              <tr key={revision.revision}>
                <td>{revision.revision}</td>
                <td>{revision.kind}</td>
                <td className="mono">{revision.savedBy}</td>
                <td>
                  <Instant value={revision.savedAt} />
                </td>
                <td className="mono">{revision.provenance?.model ?? ''}</td>
                <td>
                  {revision.provenance === null
                    ? ''
                    : `${revision.provenance.inputTokens} / ${revision.provenance.outputTokens}`}
                </td>
                <td>
                  {revision.provenance === null
                    ? ''
                    : dollars(revision.provenance.costMicrodollars)}
                </td>
                <td>{revision.provenance?.wordCount ?? ''}</td>
                <td>{revision.provenance?.namingBasis ?? ''}</td>
                <td>
                  {revision.provenance === null
                    ? ''
                    : `${revision.provenance.sourcesRead} / ${revision.provenance.sourcesPartlyRead} / ${revision.provenance.sourcesNotRead}`}
                </td>
                <td>
                  {view.publishedRevision === revision.revision ? (
                    view.canPublish ? (
                      <form action={unpublishAction} className="inline">
                        <Csrf token={token} />
                        <input type="hidden" name="weekRunId" value={view.week.id} />
                        <input type="hidden" name="category" value={view.category} />
                        <input type="hidden" name="output" value="article" />
                        <button type="submit" className="quiet">
                          Published · unpublish
                        </button>
                      </form>
                    ) : (
                      'published'
                    )
                  ) : view.canPublish ? (
                    <form action={publishAction} className="inline">
                      <Csrf token={token} />
                      <input type="hidden" name="weekRunId" value={view.week.id} />
                      <input type="hidden" name="category" value={view.category} />
                      <input type="hidden" name="output" value="article" />
                      <input type="hidden" name="revision" value={String(revision.revision)} />
                      <button type="submit">Publish this revision</button>
                    </form>
                  ) : (
                    ''
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {view.latest === null ? null : (
        <>
          <h3>Revision {view.latest.revision}, copy-ready</h3>
          <pre>{view.latest.markdown}</pre>
          {view.canEdit ? (
            <form action={saveArticleAction}>
              <Csrf token={token} />
              <input type="hidden" name="weekRunId" value={view.week.id} />
              <input type="hidden" name="category" value={view.category} />
              <input type="hidden" name="expectedRevision" value={String(view.latest.revision)} />
              <p className="small">
                Saving appends revision {view.latest.revision + 1}. If someone else saved first, the
                save is refused and nothing is overwritten. Revision 1 is never changed.
              </p>
              <textarea name="markdown" rows={32} cols={100} defaultValue={view.latest.markdown} />
              <p>
                <button type="submit">Save revision {view.latest.revision + 1}</button>
              </p>
            </form>
          ) : null}
        </>
      )}
    </section>
  );
}
