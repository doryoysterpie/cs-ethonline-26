import { Instant, Notice, Origin } from '../../../components/ui.tsx';
import { currentPrincipal } from '../../../server/dal/principal.ts';
import { commandCenter } from '../../../server/dal/read.ts';
import { attempt, escalate } from '../../page-support.ts';

export const dynamic = 'force-dynamic';

export default async function DraftsPage() {
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() => commandCenter(runtime, principal));
  if (!result.ok) return <Notice code={escalate(result.error)} />;
  return (
    <section>
      <h2>Drafts</h2>
      <p className="small">
        A draft is generated deterministically from one completed evidence run over an explicit
        period. No editorial week is inferred (decision D10 is unresolved), so both bounds are
        required.
      </p>
      {result.value.evidenceRuns
        .filter((run) => run.status === 'completed')
        .map((run) => (
          <form key={run.id} className="stack" method="get" action={`/drafts/${run.id}`}>
            <p>
              Evidence run <span className="mono">{run.id}</span> <Origin value={run.dataOrigin} />{' '}
              · started <Instant value={run.startedAt} /> · {run.incidentCount} incidents
            </p>
            <label>
              Period start (UTC)
              <input name="start" required placeholder="2026-08-09T00:00:00Z" />
            </label>
            <label>
              Period end (UTC)
              <input name="end" required placeholder="2026-08-16T00:00:00Z" />
            </label>
            <button type="submit">Open draft</button>
          </form>
        ))}
    </section>
  );
}
