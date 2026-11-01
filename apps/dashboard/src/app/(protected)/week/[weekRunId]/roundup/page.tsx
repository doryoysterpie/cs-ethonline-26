import Link from 'next/link';

import { Csrf, Instant, Notice, Origin, SectionBlock } from '../../../../../components/ui.tsx';
import { csrfFor, currentPrincipal } from '../../../../../server/dal/principal.ts';
import { roundupView } from '../../../../../server/dal/read.ts';
import {
  attempt,
  escalate,
  removedAt,
  single,
  type SearchParams,
} from '../../../../page-support.ts';
import { publishAction, unpublishAction } from '../publish-actions.ts';
import { generateAction, saveRoundupAction } from './actions.ts';

export const dynamic = 'force-dynamic';

function dollars(microdollars: number): string {
  return `USD ${(microdollars / 1_000_000).toFixed(4)}`;
}

export default async function RoundupPage({
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
    roundupView(runtime, principal, weekRunId, single(query.category)),
  );
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  const view = result.value;
  const token = principal === null ? '' : csrfFor(principal);
  return (
    <section>
      <h2>
        Round-up for week <span className="mono">{view.week.id}</span> · {view.category}{' '}
        <Origin value={view.week.dataOrigin} />
      </h2>
      <Notice
        code={single(query.notice)}
        at={single(query.at)}
        more={single(query.more)}
        field={single(query.field)}
        removed={removedAt(view.revisions, single(query.revision))}
      />
      <p className="small">
        Window <Instant value={view.week.windowStart} /> to <Instant value={view.week.windowEnd} />{' '}
        · {view.selectedIncidents} incidents selected · template {view.templateVersion}{' '}
        <span className="mono">{view.templateHash.slice(0, 12)}</span> · model spend this month{' '}
        {dollars(view.spendThisMonthMicrodollars)} of {dollars(view.capMicrodollars)} ·{' '}
        <Link href={`/week/${view.week.id}?category=${encodeURIComponent(view.category)}`}>
          back to the sift table
        </Link>
      </p>
      {view.canGenerate ? (
        view.modelConfigured ? (
          <form action={generateAction}>
            <Csrf token={token} />
            <input type="hidden" name="weekRunId" value={view.week.id} />
            <input type="hidden" name="category" value={view.category} />
            <input type="hidden" name="templateHash" value={view.templateHash} />
            <p className="small">
              Generation sends the selected stories’ recorded fields, and nothing else, to the model
              named in D9, once, and records revision 0 (deterministic) and revision 1 (generated)
              with the token counts and cost.
            </p>
            <button type="submit" disabled={view.selectedIncidents === 0}>
              Generate round-up
            </button>
          </form>
        ) : (
          <p className="small">No model credential is configured; generation is unavailable.</p>
        )
      ) : null}
      {view.revisions.length > 0 ? (
        <SectionBlock title="Revisions">
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
                  <td>
                    {view.publishedRevision === revision.revision ? (
                      view.canPublish ? (
                        <form action={unpublishAction} className="inline">
                          <Csrf token={token} />
                          <input type="hidden" name="weekRunId" value={view.week.id} />
                          <input type="hidden" name="category" value={view.category} />
                          <input type="hidden" name="output" value="roundup" />
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
                        <input type="hidden" name="output" value="roundup" />
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
        </SectionBlock>
      ) : null}
      {view.latest === null ? null : (
        <>
          <h3>Revision {view.latest.revision}, copy-ready</h3>
          <pre>{view.latest.markdown}</pre>
          {view.canEdit ? (
            <form action={saveRoundupAction}>
              <Csrf token={token} />
              <input type="hidden" name="weekRunId" value={view.week.id} />
              <input type="hidden" name="category" value={view.category} />
              <input type="hidden" name="expectedRevision" value={String(view.latest.revision)} />
              <p className="small">
                Saving appends revision {view.latest.revision + 1}. If someone else saved first, the
                save is refused and nothing is overwritten. Revisions 0 and 1 are never changed.
              </p>
              <textarea name="markdown" rows={24} cols={100} defaultValue={view.latest.markdown} />
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
