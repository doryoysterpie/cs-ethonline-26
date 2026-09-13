import Link from 'next/link';

import { Csrf, Instant, Notice, Origin, Text } from '../../../../components/ui.tsx';
import { csrfFor, currentPrincipal } from '../../../../server/dal/principal.ts';
import { reviewQueue } from '../../../../server/dal/read.ts';
import { attempt, escalate, single, type SearchParams } from '../../../page-support.ts';
import { reviewAction } from './actions.ts';

export const dynamic = 'force-dynamic';

export default async function QueuePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly classificationRunId: string }>;
  readonly searchParams: SearchParams;
}) {
  const { classificationRunId } = await params;
  const query = await searchParams;
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() =>
    reviewQueue(runtime, principal, classificationRunId, single(query.after)),
  );
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  const view = result.value;
  const token = principal === null ? '' : csrfFor(principal);
  return (
    <section>
      <h2>
        Queue for run <span className="mono">{view.run.id}</span>{' '}
        <Origin value={view.run.dataOrigin} />
      </h2>
      <Notice code={single(query.notice)} />
      <p className="small">
        {view.run.reviewCount} rows need review · batch{' '}
        <span className="mono">{view.run.batchId}</span>
      </p>
      <table>
        <thead>
          <tr>
            <th>Row</th>
            <th>Origin</th>
            <th>Title (stored text, escaped)</th>
            <th>Derived summary (escaped)</th>
            <th>URL (not linked)</th>
            <th>Rationale codes</th>
            <th>Score</th>
            <th>Posted</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          {view.entries.map((entry) => (
            <tr key={entry.sourceRowId}>
              <td>{entry.rowNumber}</td>
              <td>
                <Origin value={entry.dataOrigin} />
              </td>
              <td>
                <Text value={entry.title} />
              </td>
              <td>
                <Text value={entry.summary} max={400} />
              </td>
              <td className="mono">
                <Text value={entry.url} />
              </td>
              <td className="mono">{entry.rationaleCodes.join(', ')}</td>
              <td>{entry.signalScore}</td>
              <td>
                <Instant value={entry.postedAt} />
              </td>
              <td>
                {entry.decision === null ? null : (
                  <p className="small">
                    {entry.decision.reviewState} · {entry.decision.reasonCode} ·{' '}
                    {entry.decision.decidedBy} · <Instant value={entry.decision.decidedAt} />
                    {entry.decision.note === null ? null : (
                      <>
                        {' '}
                        · note: <Text value={entry.decision.note} />
                      </>
                    )}
                  </p>
                )}
                <form action={reviewAction} className="stack">
                  <Csrf token={token} />
                  <input type="hidden" name="classificationRunId" value={view.run.id} />
                  <input type="hidden" name="sourceRowId" value={entry.sourceRowId} />
                  <label>
                    Review state
                    <select name="reviewState" defaultValue="selected">
                      <option value="selected">selected</option>
                      <option value="rejected">rejected</option>
                      <option value="unreviewed">unreviewed</option>
                    </select>
                  </label>
                  <label>
                    Reason code
                    <input
                      name="reasonCode"
                      required
                      pattern="[a-z][a-z0-9_]{2,63}"
                      maxLength={64}
                      defaultValue="editorial_judgement"
                    />
                  </label>
                  <label>
                    Note (optional, private to editors)
                    <input name="note" maxLength={280} />
                  </label>
                  <button type="submit">Record</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.nextAfterRowNumber === null ? null : (
        <p>
          <Link href={`/queue/${view.run.id}?after=${view.nextAfterRowNumber}`}>Next page</Link>
        </p>
      )}
    </section>
  );
}
