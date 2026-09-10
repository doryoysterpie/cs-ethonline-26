import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  anomalyFeed,
  chainAnomalies,
  reportingAnomalies,
  CHAIN_LIMITATION,
  REPORTING_LIMITATION,
  type AnomalyEntry,
  type ChainTargetSeries,
  type ReportingWindow,
  type ValueObservation,
} from './anomaly.js';
import { EVIDENCE_REASON_CODES } from './contract.js';
import {
  correlate,
  resolveEvidenceState,
  type AcceptedAssociation,
  type IncidentSubject,
  type SignalSubject,
} from './correlate.js';

/**
 * The synthetic replay fixtures, exercised against the shipped contract.
 *
 * These are the cases a reader would otherwise have to take on trust: that a
 * flat series stays normal, that a large movement is a spike, that a gap, a
 * stale reading and a short history are each reported as themselves rather
 * than smoothed into a spike, that a reporting-volume movement and a story
 * concentration are separate observations, and that an incident correlates
 * only on an identity a person recorded.
 *
 * The fixtures are committed data under `data/fixtures/evidence/` and are
 * regenerable byte-for-byte. Nothing in them is copied or derived from a
 * provider response, an export or a publication.
 */

const FIXTURES = fileURLToPath(new URL('../../../data/fixtures/evidence/', import.meta.url));

function readFixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(`${FIXTURES}${relativePath}`, 'utf8')) as T;
}

const AS_OF = Math.floor(Date.parse('2026-09-04T09:11:23Z') / 1000);

interface SnapshotObservation {
  readonly chain: 'ethereum' | 'base';
  readonly protocolSlug: string;
  readonly observedAt: string;
  readonly deltaPercent: string;
}

interface Snapshot {
  readonly gatewayHost: string;
  readonly querySha256: string;
  readonly observations: readonly SnapshotObservation[];
}

/** Rebuilds each target's series from the twelve daily snapshot files. */
function replaySeries(): ChainTargetSeries[] {
  const byTarget = new Map<
    string,
    { chain: 'ethereum' | 'base'; slug: string; rows: ValueObservation[] }
  >();
  for (let day = 1; day <= 12; day += 1) {
    const snapshot = readFixture<Snapshot>(`snapshots/replay-${String(day).padStart(2, '0')}.json`);
    for (const observation of snapshot.observations) {
      const key = `${observation.chain}:${observation.protocolSlug}`;
      const existing = byTarget.get(key) ?? {
        chain: observation.chain,
        slug: observation.protocolSlug,
        rows: [],
      };
      existing.rows.push({
        observedAt: Math.floor(Date.parse(observation.observedAt) / 1000),
        deltaPercent: observation.deltaPercent,
      });
      byTarget.set(key, existing);
    }
  }
  return [...byTarget.entries()].map(([targetId, target]) => ({
    targetId,
    chain: target.chain,
    protocolSlug: target.slug,
    dataOrigin: 'replay' as const,
    provenanceId: 'replay-signal-run',
    observations: target.rows,
  }));
}

function entryFor(entries: readonly AnomalyEntry[], targetId: string): AnomalyEntry {
  const found = entries.find((entry) => entry.subjectId === targetId);
  if (found === undefined) throw new Error(`no entry for ${targetId}`);
  return found;
}

describe('chain replay fixtures', () => {
  const series = replaySeries();
  const entries = chainAnomalies(series, AS_OF);

  it('covers the seven standardized identities decision D23 retained', () => {
    expect(series.map((target) => target.targetId).sort()).toEqual([
      'base:moonwell',
      'base:seamless-protocol',
      'ethereum:aave-v3',
      'ethereum:compound-v3',
      'ethereum:liquity',
      'ethereum:makerdao',
      'ethereum:spark-lend',
    ]);
    expect(entries).toHaveLength(7);
  });

  it('labels ordinary daily movement as normal', () => {
    const entry = entryFor(entries, 'ethereum:aave-v3');
    expect(entry.label).toBe('normal');
    expect(entry.value).toBe('0.29');
    expect(entry.reasonCodes).toEqual([]);
    expect(entry.baselineWindow).not.toBeNull();
  });

  it('labels a large positive movement as a positive spike', () => {
    const entry = entryFor(entries, 'ethereum:spark-lend');
    expect(entry.label).toBe('positive_spike');
    expect(entry.value).toBe('31.5');
    // The floor decides here rather than the spread: four median absolute
    // deviations of ordinary daily noise are well under five percent.
    expect(entry.threshold).toBe('5');
  });

  it('labels a large negative movement as a negative spike', () => {
    const entry = entryFor(entries, 'ethereum:compound-v3');
    expect(entry.label).toBe('negative_spike');
    expect(entry.value).toBe('-27.8');
  });

  it('falls back to the absolute floor when the baseline never moved', () => {
    const entry = entryFor(entries, 'ethereum:makerdao');
    expect(entry.label).toBe('positive_spike');
    expect(entry.reasonCodes).toEqual([EVIDENCE_REASON_CODES.zeroBaseline]);
    expect(entry.threshold).toBe('5');
  });

  it('reports too little history as itself rather than as a spike', () => {
    const entry = entryFor(entries, 'ethereum:liquity');
    expect(entry.label).toBe('insufficient_history');
    expect(entry.reasonCodes).toEqual([EVIDENCE_REASON_CODES.insufficientHistory]);
    expect(entry.baselineWindow).toBeNull();
  });

  it('reports a hole in the series rather than computing a baseline across it', () => {
    const entry = entryFor(entries, 'base:seamless-protocol');
    expect(entry.label).toBe('missing_observation');
    expect(entry.reasonCodes).toEqual([EVIDENCE_REASON_CODES.observationMissing]);
  });

  it('reports an old reading as stale whatever its value', () => {
    const entry = entryFor(entries, 'base:moonwell');
    expect(entry.label).toBe('stale_observation');
    expect(entry.reasonCodes).toEqual([EVIDENCE_REASON_CODES.observationStale]);
    expect(entry.baselineWindow).toBeNull();
  });

  it('states the limitation of every chain entry in fixed words', () => {
    for (const entry of entries) {
      expect(entry.evidenceLimitation).toBe(CHAIN_LIMITATION);
      expect(entry.dataOrigin).toBe('replay');
    }
  });

  it('never labels a spike on the strength of absent data', () => {
    const absent = entries.filter((entry) =>
      ['insufficient_history', 'missing_observation', 'stale_observation'].includes(entry.label),
    );
    expect(absent).toHaveLength(3);
    for (const entry of absent) expect(entry.label.endsWith('_spike')).toBe(false);
  });

  it('produces the same feed whatever order the targets arrive in', () => {
    const forwards = anomalyFeed(series, [], AS_OF);
    const backwards = anomalyFeed([...series].reverse(), [], AS_OF);
    expect(backwards).toEqual(forwards);
    expect(forwards.stats).toEqual({
      chainTargets: 7,
      reportingWindows: 0,
      spikes: 3,
      insufficientHistory: 1,
      stale: 1,
      missing: 1,
      boundsReached: 0,
    });
  });
});

interface ReportingScenario {
  readonly id: string;
  readonly expect: { readonly volume: string; readonly concentration: string | null };
  readonly windows: readonly {
    readonly windowId: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly sourceStoryCount: number;
    readonly incidentCount: number;
    readonly multiSourceIncidentCount: number;
  }[];
}

function scenarioWindows(scenario: ReportingScenario): ReportingWindow[] {
  return scenario.windows.map((window) => ({
    windowId: window.windowId,
    startsAt: Math.floor(Date.parse(window.startsAt) / 1000),
    endsAt: Math.floor(Date.parse(window.endsAt) / 1000),
    dataOrigin: 'replay' as const,
    provenanceId: 'replay-clustering-run',
    sourceStoryCount: window.sourceStoryCount,
    incidentCount: window.incidentCount,
    multiSourceIncidentCount: window.multiSourceIncidentCount,
  }));
}

describe('reporting replay fixtures', () => {
  const scenarios = readFixture<{ readonly scenarios: readonly ReportingScenario[] }>(
    'reporting-windows.json',
  ).scenarios;

  function scenario(id: string): ReportingScenario {
    const found = scenarios.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`no scenario ${id}`);
    return found;
  }

  it('labels every fixture scenario as the fixture declares', () => {
    for (const entry of scenarios) {
      const produced = reportingAnomalies(scenarioWindows(entry));
      expect(produced[0]?.label, entry.id).toBe(entry.expect.volume);
      if (entry.expect.concentration === null) {
        expect(produced, entry.id).toHaveLength(1);
      } else {
        expect(produced[1]?.label, entry.id).toBe(entry.expect.concentration);
      }
    }
  });

  it('keeps a story-volume spike separate from a story concentration', () => {
    const volume = reportingAnomalies(scenarioWindows(scenario('volume-spike')));
    expect(volume[0]?.label).toBe('positive_spike');
    expect(volume[1]?.label).toBe('normal');
    expect(volume[1]?.subjectId).toBe('replay-window-04:concentration');

    const concentration = reportingAnomalies(scenarioWindows(scenario('story-concentration')));
    expect(concentration[0]?.label).toBe('normal');
    expect(concentration[1]?.label).toBe('positive_spike');
    // Many stories collapsed into few incidents, on ordinary weekly volume.
    expect(concentration[1]?.value).toBe('5.111111');
  });

  it('raises nothing from a high incident count alone', () => {
    const entries = reportingAnomalies(
      scenarioWindows(scenario('high-incident-count-no-volume-spike')),
    );
    const window = scenario('high-incident-count-no-volume-spike').windows.at(-1);
    expect(window?.incidentCount).toBe(44);
    expect(entries.every((entry) => entry.label === 'normal')).toBe(true);
  });

  it('refuses to judge a window without enough prior windows', () => {
    const entries = reportingAnomalies(scenarioWindows(scenario('insufficient-windows')));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe('insufficient_history');
    expect(entries[0]?.reasonCodes).toEqual([EVIDENCE_REASON_CODES.insufficientHistory]);
  });

  it('states the limitation of every reporting entry in fixed words', () => {
    for (const entry of scenarios) {
      for (const produced of reportingAnomalies(scenarioWindows(entry))) {
        expect(produced.evidenceLimitation).toBe(REPORTING_LIMITATION);
        expect(produced.chain).toBeNull();
        expect(produced.protocolSlug).toBeNull();
      }
    }
  });
});

interface CorrelationFixture {
  readonly incidents: readonly {
    readonly incidentId: string;
    readonly label: string;
    readonly clusteringRunId: string;
    readonly batchId: string;
    readonly chain: 'ethereum' | 'base' | null;
    readonly protocolSlug: string | null;
    readonly earliestReportedAt: string | null;
    readonly claimIds: readonly string[];
  }[];
  readonly signals: readonly {
    readonly signalId: string;
    readonly label: string;
    readonly signalRunId: string;
    readonly chain: 'ethereum' | 'base';
    readonly protocolSlug: string;
    readonly observedAt: string;
    readonly deltaPercent: string;
  }[];
  readonly decisions: readonly {
    readonly incidentId: string;
    readonly signalId: string;
    readonly claimId: string | null;
    readonly relation: 'supports' | 'conflicts' | 'context';
    readonly status: 'suggested' | 'accepted' | 'rejected';
  }[];
  readonly expectedStates: Readonly<Record<string, string>>;
}

describe('correlation replay fixtures', () => {
  const fixture = readFixture<CorrelationFixture>('correlation.json');
  const incidents: IncidentSubject[] = fixture.incidents.map((row) => ({
    incidentId: row.incidentId,
    clusteringRunId: row.clusteringRunId,
    batchId: row.batchId,
    chain: row.chain,
    protocolSlug: row.protocolSlug,
    earliestReportedAt:
      row.earliestReportedAt === null
        ? null
        : Math.floor(Date.parse(row.earliestReportedAt) / 1000),
    claimIds: row.claimIds,
  }));
  const signals: SignalSubject[] = fixture.signals.map((row) => ({
    signalId: row.signalId,
    signalRunId: row.signalRunId,
    chain: row.chain,
    protocolSlug: row.protocolSlug,
    observedAt: Math.floor(Date.parse(row.observedAt) / 1000),
    deltaPercent: row.deltaPercent,
  }));
  const idOf = (label: string): string => {
    const incident = fixture.incidents.find((row) => row.label === label);
    if (incident === undefined) throw new Error(`no incident ${label}`);
    return incident.incidentId;
  };
  const outcome = correlate(incidents, signals);

  it('suggests only where a recorded identity matches inside the window', () => {
    expect(outcome.stats.considered).toBe(incidents.length * signals.length);
    const suggested = new Set(outcome.suggestions.map((suggestion) => suggestion.incidentId));
    expect([...suggested].sort()).toEqual(
      [idOf('corroborated-aave'), idOf('contradicted-compound'), idOf('observed-moonwell')].sort(),
    );
  });

  it('refuses an incident that names no protocol', () => {
    const refusals = outcome.rejections.filter(
      (rejection) => rejection.incidentId === idOf('unnamed-protocol'),
    );
    expect(refusals).toHaveLength(signals.length);
    for (const refusal of refusals) {
      expect(refusal.reasonCodes).toEqual([EVIDENCE_REASON_CODES.protocolNotNamed]);
    }
  });

  it('refuses a matching protocol on a different chain', () => {
    const spark = fixture.signals.find((row) => row.label === 'spark-ethereum');
    const refusal = outcome.rejections.find(
      (entry) =>
        entry.incidentId === idOf('chain-mismatch-spark') && entry.signalId === spark?.signalId,
    );
    expect(refusal?.reasonCodes).toEqual([EVIDENCE_REASON_CODES.chainMismatch]);
  });

  it('refuses an observation outside the declared window', () => {
    const late = fixture.signals.find((row) => row.label === 'liquity-late');
    const refusal = outcome.rejections.find(
      (entry) =>
        entry.incidentId === idOf('outside-window-liquity') && entry.signalId === late?.signalId,
    );
    expect(refusal?.reasonCodes).toEqual([EVIDENCE_REASON_CODES.signalOutsideWindow]);
  });

  it('refuses a movement below the magnitude floor', () => {
    const small = fixture.signals.find((row) => row.label === 'makerdao-small');
    const refusal = outcome.rejections.find(
      (entry) =>
        entry.incidentId === idOf('below-floor-makerdao') && entry.signalId === small?.signalId,
    );
    expect(refusal?.reasonCodes).toEqual([EVIDENCE_REASON_CODES.magnitudeBelowFloor]);
  });

  it('refuses an incident with no recorded report time', () => {
    const seamless = fixture.signals.find((row) => row.label === 'seamless-drop');
    const refusal = outcome.rejections.find(
      (entry) =>
        entry.incidentId === idOf('no-reported-time-seamless') &&
        entry.signalId === seamless?.signalId,
    );
    expect(refusal?.reasonCodes).toEqual([EVIDENCE_REASON_CODES.signalOutsideWindow]);
  });

  it('resolves every fixture incident to the state the fixture declares', () => {
    const decided: AcceptedAssociation[] = outcome.suggestions.map((suggestion) => {
      const decision = fixture.decisions.find(
        (entry) =>
          entry.incidentId === suggestion.incidentId && entry.signalId === suggestion.signalId,
      );
      return {
        incidentId: suggestion.incidentId,
        signalId: suggestion.signalId,
        claimId: decision?.claimId ?? suggestion.claimId,
        relation: decision?.relation ?? suggestion.relation,
        status: decision?.status ?? 'suggested',
      };
    });
    for (const [label, state] of Object.entries(fixture.expectedStates)) {
      expect(resolveEvidenceState(idOf(label), decided).state, label).toBe(state);
    }
  });

  it('leaves every incident reported_only until a person accepts something', () => {
    const undecided: AcceptedAssociation[] = outcome.suggestions.map((suggestion) => ({
      incidentId: suggestion.incidentId,
      signalId: suggestion.signalId,
      claimId: suggestion.claimId,
      relation: suggestion.relation,
      status: 'suggested' as const,
    }));
    for (const incident of incidents) {
      expect(resolveEvidenceState(incident.incidentId, undecided).state).toBe('reported_only');
    }
  });
});
