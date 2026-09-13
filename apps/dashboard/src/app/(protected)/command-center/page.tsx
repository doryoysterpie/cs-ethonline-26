import Link from 'next/link';

import { Instant, Notice, Origin } from '../../../components/ui.tsx';
import { currentPrincipal } from '../../../server/dal/principal.ts';
import { commandCenter } from '../../../server/dal/read.ts';
import { attempt, escalate, single, type SearchParams } from '../../page-support.ts';

export const dynamic = 'force-dynamic';

export default async function CommandCenterPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() => commandCenter(runtime, principal));
  const params = await searchParams;
  if (!result.ok) {
    const code = escalate(result.error);
    return <Notice code={code} />;
  }
  const view = result.value;
  return (
    <section>
      <h2>Command center</h2>
      <Notice code={single(params.notice)} />
      <table>
        <thead>
          <tr>
            <th>Import batches</th>
            <th>Classification runs</th>
            <th>Clustering runs</th>
            <th>Graph signal runs</th>
            <th>Evidence runs</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{view.totals.importBatches}</td>
            <td>{view.totals.classificationRuns}</td>
            <td>{view.totals.clusteringRuns}</td>
            <td>{view.totals.graphSignalRuns}</td>
            <td>{view.totals.evidenceRuns}</td>
          </tr>
        </tbody>
      </table>

      <h3>Evidence runs</h3>
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Origin</th>
            <th>Status</th>
            <th>Incidents</th>
            <th>Suggestions</th>
            <th>Reported only</th>
            <th>On-chain observed</th>
            <th>Corroborated</th>
            <th>Contradicted</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {view.evidenceRuns.map((run) => (
            <tr key={run.id}>
              <td>
                <Link href={`/evidence/${run.id}`} className="mono">
                  {run.id.slice(0, 8)}
                </Link>
              </td>
              <td>
                <Origin value={run.dataOrigin} />
              </td>
              <td>{run.status}</td>
              <td>{run.incidentCount}</td>
              <td>{run.suggestionCount}</td>
              <td>{run.reportedOnly}</td>
              <td>{run.onchainObserved}</td>
              <td className="state-corroborated">{run.corroborated}</td>
              <td className="state-contradicted">{run.contradicted}</td>
              <td>
                <Instant value={run.startedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Clustering runs</h3>
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Origin</th>
            <th>Status</th>
            <th>Incidents</th>
            <th>Multi-source</th>
            <th>Ambiguous links</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {view.clusteringRuns.map((run) => (
            <tr key={run.id}>
              <td>
                <Link href={`/incidents/${run.id}`} className="mono">
                  {run.id.slice(0, 8)}
                </Link>
              </td>
              <td>
                <Origin value={run.dataOrigin} />
              </td>
              <td>{run.status}</td>
              <td>{run.incidentCount}</td>
              <td>{run.multiSourceIncidentCount}</td>
              <td>{run.ambiguousLinkCount}</td>
              <td>
                <Instant value={run.startedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Graph signal runs</h3>
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Origin</th>
            <th>Status</th>
            <th>Gateway host</th>
            <th>Targets</th>
            <th>Signals</th>
            <th>Failed targets</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {view.signalRuns.map((run) => (
            <tr key={run.id}>
              <td>
                <Link href={`/anomaly/${run.id}`} className="mono">
                  {run.id.slice(0, 8)}
                </Link>
              </td>
              <td>
                <Origin value={run.dataOrigin} />
              </td>
              <td>{run.status}</td>
              <td className="mono">{run.gatewayHost}</td>
              <td>{run.targetCount}</td>
              <td>{run.signalCount}</td>
              <td>{run.failedTargetCount}</td>
              <td>
                <Instant value={run.startedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Classification runs</h3>
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Origin</th>
            <th>Batch</th>
            <th>Include</th>
            <th>Exclude</th>
            <th>Needs review</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {view.classificationRuns.map((run) => (
            <tr key={run.id}>
              <td className="mono">{run.id.slice(0, 8)}</td>
              <td>
                <Origin value={run.dataOrigin} />
              </td>
              <td className="mono">{run.batchId.slice(0, 8)}</td>
              <td>{run.includeCount}</td>
              <td>{run.excludeCount}</td>
              <td>{run.reviewCount}</td>
              <td>
                <Instant value={run.startedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
