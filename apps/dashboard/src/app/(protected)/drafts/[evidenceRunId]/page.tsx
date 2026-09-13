import { SafeMarkdown } from '../../../../components/SafeMarkdown.tsx';
import { Csrf, Instant, Limitation, Notice, Origin } from '../../../../components/ui.tsx';
import { csrfFor, currentPrincipal } from '../../../../server/dal/principal.ts';
import { draftView } from '../../../../server/dal/read.ts';
import { attempt, escalate, single, type SearchParams } from '../../../page-support.ts';
import { saveDraftAction } from './actions.ts';

export const dynamic = 'force-dynamic';

export default async function DraftPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly evidenceRunId: string }>;
  readonly searchParams: SearchParams;
}) {
  const { evidenceRunId } = await params;
  const query = await searchParams;
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() =>
    draftView(runtime, principal, evidenceRunId, single(query.start), single(query.end)),
  );
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  const view = result.value;
  const token = principal === null ? '' : csrfFor(principal);
  return (
    <section>
      <h2>
        Draft for evidence run <span className="mono">{view.evidenceRun.id}</span>{' '}
        <Origin value={view.evidenceRun.dataOrigin} />
      </h2>
      <Notice code={single(query.notice)} />
      <p className="small">
        Period {view.periodStart} to {view.periodEnd} · status{' '}
        <span className="mono">{view.status}</span> · showing{' '}
        {view.revision === 0
          ? 'the generated draft (revision 0)'
          : `human revision ${view.revision}`}
      </p>
      <Limitation>
        Generated deterministically; no model was called and nothing here is AI-generated. Every
        claim is <span className="mono">reported</span>; every name is withheld under the
        provisional naming policy (D4). Nothing is published from this page.
      </Limitation>
      <table>
        <thead>
          <tr>
            <th>Incidents</th>
            <th>Claims written</th>
            <th>Claims omitted (no source)</th>
            <th>Names withheld</th>
            <th>Contradicted incidents</th>
            <th>Latest in Crypto</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{view.counts.incidents}</td>
            <td>{view.counts.claimsWritten}</td>
            <td>{view.counts.claimsOmitted}</td>
            <td>{view.counts.namesWithheld}</td>
            <td className="state-contradicted">{view.counts.contradicted}</td>
            <td className="feed-crypto">
              <span className="feed-name">{view.counts.cryptoIncidents}</span>
            </td>
          </tr>
        </tbody>
      </table>

      <h3>Preview (sanitized rendering of stored Markdown)</h3>
      <SafeMarkdown markdown={view.markdown} />

      {view.revisions.length > 0 ? (
        <>
          <h3>Revisions</h3>
          <table>
            <thead>
              <tr>
                <th>Revision</th>
                <th>Saved by</th>
                <th>Saved at</th>
              </tr>
            </thead>
            <tbody>
              {view.revisions.map((revision) => (
                <tr key={revision.revision}>
                  <td>{revision.revision}</td>
                  <td className="mono">{revision.savedBy}</td>
                  <td>
                    <Instant value={revision.savedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {view.canEdit && principal !== null ? (
        <>
          <h3>Edit</h3>
          <p className="small">
            Saving appends revision {view.revision + 1}. If someone else saved first, the save is
            refused and nothing is overwritten. The generated draft (revision 0) is never changed.
          </p>
          <form className="stack" action={saveDraftAction}>
            <Csrf token={token} />
            <input type="hidden" name="evidenceRunId" value={view.evidenceRun.id} />
            <input type="hidden" name="periodStart" value={view.periodStart} />
            <input type="hidden" name="periodEnd" value={view.periodEnd} />
            <input type="hidden" name="expectedRevision" value={String(view.revision)} />
            <label>
              Markdown
              <textarea name="markdown" className="draft" defaultValue={view.markdown} required />
            </label>
            <button type="submit">Save revision {view.revision + 1}</button>
          </form>
        </>
      ) : null}
    </section>
  );
}
