import { describe, expect, it } from 'vitest';

import {
  anomalyFeed,
  chainAnomalies,
  CHAIN_LIMITATION,
  reportingAnomalies,
  REPORTING_LIMITATION,
  type ChainTargetSeries,
  type ReportingWindow,
  type ValueObservation,
} from './anomaly.js';
import { EVIDENCE_CONTRACT, EVIDENCE_REASON_CODES, type EvidenceContract } from './contract.js';

/**
 * The anomaly feed. Every figure below is invented for the test; nothing here
 * came from a provider or from the editorial corpus.
 *
 * The property most of these cases exist to protect is the same one: a
 * movement is never called anomalous on evidence that is not there. Short
 * history, a gap, a stale reading and a flat baseline each have their own
 * label, and none of them is a spike.
 */

const HOUR = 3600;
const DAY = 24 * HOUR;
const NOW = 1_757_000_000;

/** A quiet series ending `hoursAgo` before `NOW`, with the last delta replaced. */
function series(
  latestDelta: string,
  options: {
    readonly count?: number;
    readonly hoursAgo?: number;
    readonly quiet?: string;
    readonly gapAfter?: number;
  } = {},
): ChainTargetSeries {
  const count = options.count ?? 10;
  const hoursAgo = options.hoursAgo ?? 1;
  const quiet = options.quiet ?? '0.4';
  const end = NOW - hoursAgo * HOUR;
  const observations: ValueObservation[] = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const gap = options.gapAfter !== undefined && index < options.gapAfter ? 3 : 1;
    observations.push({
      observedAt: end - index * DAY * gap,
      // A little variation, so the baseline spread is not zero by accident.
      deltaPercent: index % 2 === 0 ? quiet : `-${quiet}`,
    });
  }
  const last = observations[observations.length - 1];
  if (last !== undefined) {
    observations[observations.length - 1] = { ...last, deltaPercent: latestDelta };
  }
  return {
    targetId: 'aave-v3-ethereum',
    chain: 'ethereum',
    protocolSlug: 'aave-v3',
    dataOrigin: 'fixture',
    provenanceId: 'signal-run-1',
    observations,
  };
}

function window(overrides: Partial<ReportingWindow> = {}): ReportingWindow {
  return {
    windowId: 'window-1',
    startsAt: NOW - 7 * DAY,
    endsAt: NOW,
    dataOrigin: 'replay',
    provenanceId: 'batch-1',
    sourceStoryCount: 100,
    incidentCount: 80,
    multiSourceIncidentCount: 5,
    ...overrides,
  };
}

describe('chain anomalies', () => {
  it('labels a quiet movement normal and says what it does not establish', () => {
    const [entry] = chainAnomalies([series('0.5')], NOW);
    expect(entry?.label).toBe('normal');
    expect(entry?.signalType).toBe('chain_tvl');
    expect(entry?.evidenceLimitation).toBe(CHAIN_LIMITATION);
    expect(entry?.evidenceLimitation).toContain('does not establish that a cyberattack occurred');
    expect(entry?.dataOrigin).toBe('fixture');
    expect(entry?.baselineWindow).not.toBeNull();
  });

  it('labels a large positive and a large negative movement as spikes', () => {
    expect(chainAnomalies([series('42.5')], NOW)[0]?.label).toBe('positive_spike');
    expect(chainAnomalies([series('-42.5')], NOW)[0]?.label).toBe('negative_spike');
  });

  it('never calls a movement a spike when the history is too short', () => {
    const minimum = EVIDENCE_CONTRACT.anomaly.minimumBaselineObservations;
    const short = chainAnomalies([series('99', { count: minimum })], NOW)[0];
    expect(short?.label).toBe('insufficient_history');
    expect(short?.reasonCodes).toContain(EVIDENCE_REASON_CODES.insufficientHistory);
    expect(short?.baselineWindow).toBeNull();
    // One more observation is enough, and then the same movement is a spike.
    const enough = chainAnomalies([series('99', { count: minimum + 1 })], NOW)[0];
    expect(enough?.label).toBe('positive_spike');
  });

  it('never calls a stale observation a spike', () => {
    const limit = EVIDENCE_CONTRACT.anomaly.freshnessLimitHours;
    const stale = chainAnomalies([series('99', { hoursAgo: limit + 1 })], NOW)[0];
    expect(stale?.label).toBe('stale_observation');
    expect(stale?.reasonCodes).toContain(EVIDENCE_REASON_CODES.observationStale);
    const fresh = chainAnomalies([series('99', { hoursAgo: limit })], NOW)[0];
    expect(fresh?.label).toBe('positive_spike');
  });

  it('reports a gap in the series rather than computing across it', () => {
    const gapped = chainAnomalies([series('99', { count: 12, gapAfter: 4 })], NOW)[0];
    expect(gapped?.label).toBe('missing_observation');
    expect(gapped?.reasonCodes).toContain(EVIDENCE_REASON_CODES.observationMissing);
  });

  it('reports an empty series as missing rather than normal', () => {
    const empty = chainAnomalies([{ ...series('0'), observations: [] }], NOW)[0];
    expect(empty?.label).toBe('missing_observation');
    expect(empty?.baselineWindow).toBeNull();
  });

  it('handles a flat baseline without dividing by zero or crying spike', () => {
    const flat: ChainTargetSeries = {
      ...series('0'),
      observations: Array.from({ length: 10 }, (_, index) => ({
        observedAt: NOW - HOUR - (9 - index) * DAY,
        deltaPercent: '0',
      })),
    };
    const quiet = chainAnomalies([flat], NOW)[0];
    expect(quiet?.label).toBe('normal');
    expect(quiet?.reasonCodes).toContain(EVIDENCE_REASON_CODES.zeroBaseline);

    // With a flat baseline only the absolute floor decides, so a genuinely
    // large movement is still a spike and a small one still is not.
    const moved = { ...flat, observations: [...flat.observations] };
    const last = moved.observations[moved.observations.length - 1];
    if (last === undefined) throw new Error('no observation');
    moved.observations[moved.observations.length - 1] = { ...last, deltaPercent: '30' };
    expect(chainAnomalies([moved], NOW)[0]?.label).toBe('positive_spike');

    const strict: EvidenceContract = {
      ...EVIDENCE_CONTRACT,
      anomaly: { ...EVIDENCE_CONTRACT.anomaly, zeroDenominatorBehaviour: 'insufficient_history' },
    };
    expect(chainAnomalies([moved], NOW, strict)[0]?.label).toBe('insufficient_history');
  });

  it('never spikes below the absolute floor however still the baseline is', () => {
    const floor = EVIDENCE_CONTRACT.anomaly.minimumAbsoluteDeltaPercent;
    const tiny = chainAnomalies([series(String(floor - 0.1), { quiet: '0.0001' })], NOW)[0];
    expect(tiny?.label).toBe('normal');
  });

  it('survives extreme values without producing a non-finite output', () => {
    for (const delta of ['999999999', '-999999999', '0', '1e-9']) {
      const entry = chainAnomalies([series(delta)], NOW)[0];
      expect(entry, delta).toBeDefined();
      expect(Number.isFinite(Number(entry?.value)), delta).toBe(true);
      expect(Number.isFinite(Number(entry?.threshold)), delta).toBe(true);
    }
  });

  it('is invariant to observation order and repeats exactly', () => {
    const target = series('42.5');
    const shuffled: ChainTargetSeries = {
      ...target,
      observations: [...target.observations].reverse(),
    };
    const shape = (t: ChainTargetSeries): string => JSON.stringify(chainAnomalies([t], NOW));
    expect(shape(shuffled)).toBe(shape(target));
    for (let attempt = 0; attempt < 5; attempt += 1) expect(shape(target)).toBe(shape(target));
  });

  it('bounds how many observations it reads per target', () => {
    const bounded: EvidenceContract = {
      ...EVIDENCE_CONTRACT,
      anomaly: { ...EVIDENCE_CONTRACT.anomaly, maximumObservationsPerTarget: 8 },
    };
    const long = series('42.5', { count: 400 });
    const entry = chainAnomalies([long], NOW, bounded)[0];
    expect(entry).toBeDefined();
    // The baseline window starts inside the series rather than at its head.
    expect(entry?.baselineWindow?.startsAt).toBeGreaterThan(long.observations[0]?.observedAt ?? 0);
  });
});

describe('reporting anomalies', () => {
  const quiet = (count: number, index: number): ReportingWindow =>
    window({
      windowId: `window-${index}`,
      startsAt: NOW - (10 - index) * 7 * DAY,
      endsAt: NOW - (9 - index) * 7 * DAY,
      sourceStoryCount: count,
    });

  it('reports insufficient history before the minimum number of windows', () => {
    const entries = reportingAnomalies([quiet(100, 1), quiet(100, 2)]);
    expect(entries[0]?.label).toBe('insufficient_history');
    expect(entries[0]?.evidenceLimitation).toBe(REPORTING_LIMITATION);
  });

  it('labels a volume spike against its own prior windows', () => {
    const history = [quiet(100, 1), quiet(104, 2), quiet(98, 3), quiet(102, 4)];
    const spike = window({ windowId: 'window-5', sourceStoryCount: 900 });
    const entries = reportingAnomalies([...history, spike]);
    expect(entries[0]?.label).toBe('positive_spike');
    expect(entries[0]?.signalType).toBe('reporting_volume');
    expect(entries[0]?.chain).toBeNull();

    const normal = reportingAnomalies([...history, window({ windowId: 'window-5' })]);
    expect(normal[0]?.label).toBe('normal');
  });

  it('reports concentration separately from volume', () => {
    const history = [quiet(100, 1), quiet(104, 2), quiet(98, 3), quiet(102, 4)];
    // Many stories collapsing into few incidents, with no volume spike.
    const concentrated = window({
      windowId: 'window-5',
      sourceStoryCount: 100,
      incidentCount: 10,
      multiSourceIncidentCount: 9,
    });
    const entries = reportingAnomalies([...history, concentrated]);
    expect(entries[0]?.label).toBe('normal');
    expect(entries[1]?.subjectId).toBe('window-5:concentration');
    expect(entries[1]?.label).toBe('positive_spike');
    expect(entries[1]?.value).toBe('10');

    // A high incident count without a story-volume spike is not concentration.
    const spread = window({
      windowId: 'window-5',
      sourceStoryCount: 100,
      incidentCount: 99,
      multiSourceIncidentCount: 1,
    });
    const spreadEntries = reportingAnomalies([...history, spread]);
    expect(spreadEntries[1]?.label).toBe('normal');
  });

  it('does not divide by a zero incident count', () => {
    const history = [quiet(100, 1), quiet(104, 2), quiet(98, 3), quiet(102, 4)];
    const empty = window({ windowId: 'window-5', incidentCount: 0, multiSourceIncidentCount: 0 });
    const entries = reportingAnomalies([...history, empty]);
    expect(entries[1]?.value).toBe('0');
    expect(entries[1]?.label).toBe('normal');
    expect(entries[1]?.reasonCodes).toContain(EVIDENCE_REASON_CODES.zeroBaseline);
  });

  it('reads no weekly candidate decision, because its input carries none', () => {
    expect(Object.keys(window()).sort()).toEqual([
      'dataOrigin',
      'endsAt',
      'incidentCount',
      'multiSourceIncidentCount',
      'provenanceId',
      'sourceStoryCount',
      'startsAt',
      'windowId',
    ]);
  });
});

describe('the combined feed', () => {
  it('places chain and reporting entries side by side in a deterministic order', () => {
    const feed = anomalyFeed(
      [series('42.5'), { ...series('0.5'), targetId: 'moonwell-base', protocolSlug: 'moonwell' }],
      [window({ windowId: 'w1', startsAt: NOW - 21 * DAY, endsAt: NOW - 14 * DAY }), window()],
      NOW,
    );
    expect(feed.entries.length).toBeGreaterThan(0);
    // Chain entries sort before reporting entries, and spikes before normal.
    expect(feed.entries[0]?.signalType).toBe('chain_tvl');
    expect(feed.entries[0]?.label).toBe('positive_spike');
    expect(feed.stats.chainTargets).toBe(2);
    const again = anomalyFeed(
      [{ ...series('0.5'), targetId: 'moonwell-base', protocolSlug: 'moonwell' }, series('42.5')],
      [window(), window({ windowId: 'w1', startsAt: NOW - 21 * DAY, endsAt: NOW - 14 * DAY })],
      NOW,
    );
    expect(JSON.stringify(again.entries)).toBe(JSON.stringify(feed.entries));
  });

  it('keeps live, replay and fixture entries distinguishable', () => {
    const feed = anomalyFeed(
      [
        { ...series('42.5'), targetId: 'live-target', dataOrigin: 'live' },
        { ...series('42.5'), targetId: 'replay-target', dataOrigin: 'replay' },
        { ...series('42.5'), targetId: 'fixture-target', dataOrigin: 'fixture' },
      ],
      [],
      NOW,
    );
    const origins = feed.entries.map((entry) => `${entry.subjectId}:${entry.dataOrigin}`);
    expect(origins).toContain('live-target:live');
    expect(origins).toContain('replay-target:replay');
    expect(origins).toContain('fixture-target:fixture');
    // Every entry carries its own origin; none inherits or defaults to live.
    expect(feed.entries.every((entry) => entry.dataOrigin.length > 0)).toBe(true);
  });

  it('bounds the feed and records what it dropped', () => {
    const bounded: EvidenceContract = {
      ...EVIDENCE_CONTRACT,
      anomaly: { ...EVIDENCE_CONTRACT.anomaly, maximumFeedEntries: 2 },
    };
    const many = Array.from({ length: 6 }, (_, index) => ({
      ...series('42.5'),
      targetId: `target-${index}`,
    }));
    const feed = anomalyFeed(many, [], NOW, bounded);
    expect(feed.entries).toHaveLength(2);
    expect(feed.stats.boundsReached).toBe(4);
  });
});
