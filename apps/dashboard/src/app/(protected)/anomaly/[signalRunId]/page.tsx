import { Limitation, Notice, Origin } from '../../../../components/ui.tsx';
import { currentPrincipal } from '../../../../server/dal/principal.ts';
import { anomalyView } from '../../../../server/dal/read.ts';
import { attempt, escalate, single, type SearchParams } from '../../../page-support.ts';

export const dynamic = 'force-dynamic';

function windowsFrom(
  value: string | string[] | undefined,
): { startsAt: unknown; endsAt: unknown }[] {
  const raw = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return raw
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [startsAt, endsAt] = entry.split('..');
      return { startsAt, endsAt };
    });
}

export default async function AnomalyPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly signalRunId: string }>;
  readonly searchParams: SearchParams;
}) {
  const { signalRunId } = await params;
  const query = await searchParams;
  const { runtime, principal } = await currentPrincipal();
  const result = await attempt(() =>
    anomalyView(runtime, principal, {
      signalRunId,
      asOf: single(query.asOf) ?? null,
      clusteringRunId: single(query.clusteringRunId) ?? null,
      windows: windowsFrom(query.window),
    }),
  );
  const notice = result.ok ? null : escalate(result.error);
  return (
    <section>
      <h2>
        Anomaly feed for signal run <span className="mono">{signalRunId}</span>
      </h2>
      <form className="stack" method="get">
        <label>
          As of (UTC instant; empty means now)
          <input
            name="asOf"
            defaultValue={single(query.asOf) ?? ''}
            placeholder="2026-09-04T09:11:23Z"
          />
        </label>
        <label>
          Clustering run for the reporting side (optional UUID)
          <input name="clusteringRunId" defaultValue={single(query.clusteringRunId) ?? ''} />
        </label>
        <label>
          Reporting window (start..end, UTC; repeat the parameter for more windows)
          <input
            name="window"
            defaultValue={single(query.window) ?? ''}
            placeholder="2026-08-09T00:00:00Z..2026-08-16T00:00:00Z"
          />
        </label>
        <button type="submit">Rebuild feed</button>
      </form>
      {notice === null ? null : <Notice code={notice} />}
      {result.ok ? (
        <>
          <p className="small">
            <Origin value={result.value.run.dataOrigin} /> · as of {result.value.asOf} · gateway
            host <span className="mono">{result.value.run.gatewayHost}</span> · chain targets{' '}
            {result.value.stats.chainTargets} · reporting windows{' '}
            {result.value.stats.reportingWindows} · spikes {result.value.stats.spikes} ·
            insufficient history {result.value.stats.insufficientHistory} · stale{' '}
            {result.value.stats.stale} · missing {result.value.stats.missing} · bounded{' '}
            {result.value.stats.boundsReached}
          </p>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Label</th>
                <th>Subject</th>
                <th>Origin</th>
                <th>Observation window (unix s)</th>
                <th>Baseline window</th>
                <th>Value</th>
                <th>Threshold</th>
                <th>Reason codes</th>
                <th>Provenance</th>
              </tr>
            </thead>
            <tbody>
              {result.value.entries.map((entry) => (
                <tr key={`${entry.signalType}:${entry.subjectId}`}>
                  <td>{entry.signalType}</td>
                  <td className={`label-${entry.label}`}>{entry.label}</td>
                  <td className="mono">{entry.subjectId}</td>
                  <td>
                    <Origin value={entry.dataOrigin} />
                  </td>
                  <td className="mono">
                    {entry.observationWindow.startsAt}..{entry.observationWindow.endsAt}
                  </td>
                  <td className="mono">
                    {entry.baselineWindow === null
                      ? '—'
                      : `${entry.baselineWindow.startsAt}..${entry.baselineWindow.endsAt}`}
                  </td>
                  <td className="mono">{entry.value}</td>
                  <td className="mono">{entry.threshold}</td>
                  <td className="mono">{entry.reasonCodes.join(', ') || '—'}</td>
                  <td className="mono">{entry.provenanceId.slice(0, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.value.entries.map((entry) => (
            <Limitation key={`limitation:${entry.signalType}:${entry.subjectId}`}>
              <span className="mono">{entry.subjectId}</span>: {entry.evidenceLimitation}
            </Limitation>
          ))}
        </>
      ) : null}
    </section>
  );
}
