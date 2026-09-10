import type { AnomalyLabel, AnomalySignalType, ChainId, DataOrigin } from '@cas/contracts';

import {
  EVIDENCE_CONTRACT,
  EVIDENCE_REASON_CODES,
  type EvidenceContract,
  type EvidenceReasonCode,
} from './contract.js';

/**
 * The anomaly feed (decision D25): chain movements and reporting movements,
 * side by side, each carrying what it is and what it is not.
 *
 * Pure and deterministic. Every parameter comes from the supplied contract:
 * the observation interval, the minimum history, the baseline method, the
 * threshold, the absolute floor, what a zero spread means, what a gap means,
 * the freshness limit, the labels and the bounds.
 *
 * The rule the whole file exists to enforce: a movement is never labelled
 * anomalous on evidence that is missing. Too few observations produce
 * `insufficient_history`, a gap produces `missing_observation`, an old
 * observation produces `stale_observation`, and none of the three is a spike.
 * A spike is a statement about data that exists.
 *
 * A chain entry is telemetry about a protocol's value, not a claim that
 * anything was attacked. Every entry carries `evidenceLimitation` saying so in
 * fixed words, so nothing downstream can present it as more than it is.
 */

/** One observation of a target's value, already validated by the caller. */
export interface ValueObservation {
  /** Unix seconds. */
  readonly observedAt: number;
  /** Percentage movement against the previous observation, decimal string. */
  readonly deltaPercent: string;
}

export interface ChainTargetSeries {
  readonly targetId: string;
  readonly chain: ChainId;
  readonly protocolSlug: string;
  readonly dataOrigin: DataOrigin;
  /** Provenance identifier of the run or snapshot the series came from. */
  readonly provenanceId: string;
  readonly observations: readonly ValueObservation[];
}

/** One reporting window, counted from explicit bounds the caller supplied. */
export interface ReportingWindow {
  readonly windowId: string;
  /** Unix seconds, inclusive start and exclusive end, both explicit. */
  readonly startsAt: number;
  readonly endsAt: number;
  readonly dataOrigin: DataOrigin;
  readonly provenanceId: string;
  readonly sourceStoryCount: number;
  readonly incidentCount: number;
  readonly multiSourceIncidentCount: number;
}

export interface AnomalyEntry {
  readonly signalType: AnomalySignalType;
  readonly label: AnomalyLabel;
  readonly subjectId: string;
  /** Chain and protocol for a chain entry; null for a reporting entry. */
  readonly chain: ChainId | null;
  readonly protocolSlug: string | null;
  readonly observationWindow: { readonly startsAt: number; readonly endsAt: number };
  readonly baselineWindow: { readonly startsAt: number; readonly endsAt: number } | null;
  /** The measured value, as a decimal string. */
  readonly value: string;
  /** The threshold it was compared against, as a decimal string. */
  readonly threshold: string;
  readonly dataOrigin: DataOrigin;
  readonly provenanceId: string;
  readonly reasonCodes: readonly EvidenceReasonCode[];
  /** Fixed sentence stating what this entry does not establish. */
  readonly evidenceLimitation: string;
}

export interface AnomalyFeed {
  readonly entries: readonly AnomalyEntry[];
  readonly stats: {
    readonly chainTargets: number;
    readonly reportingWindows: number;
    readonly spikes: number;
    readonly insufficientHistory: number;
    readonly stale: number;
    readonly missing: number;
    readonly boundsReached: number;
  };
}

/** Fixed limitation sentences. Neither is ever composed from input. */
export const CHAIN_LIMITATION =
  'a value movement is circumstantial telemetry and does not establish that a cyberattack occurred';
export const REPORTING_LIMITATION =
  'a reporting-volume movement describes coverage, not incidents, and establishes nothing about any claim';

function truncate6(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const truncated = Math.trunc(value * 1_000_000) / 1_000_000;
  return String(truncated);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

interface Baseline {
  readonly centre: number;
  readonly spread: number;
}

/**
 * Centre and spread of a baseline, by the contract's method. The median
 * absolute deviation is the shipped choice because a single large spike barely
 * moves it, which is exactly the property a spike detector needs; the mean and
 * standard deviation are offered so that choice is visible and testable.
 */
function baselineOf(
  values: readonly number[],
  method: EvidenceContract['anomaly']['baselineMethod'],
): Baseline {
  if (method === 'mean-standard-deviation') {
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    const variance =
      values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
    return { centre: mean, spread: Math.sqrt(variance) };
  }
  const centre = median(values);
  const deviations = values.map((value) => Math.abs(value - centre));
  // Scaled so the deviation is comparable to a standard deviation for
  // normally distributed data.
  return { centre, spread: median(deviations) * 1.4826 };
}

function labelFor(
  delta: number,
  baseline: Baseline,
  anomaly: EvidenceContract['anomaly'],
): { label: AnomalyLabel; threshold: number; reasons: EvidenceReasonCode[] } {
  const reasons: EvidenceReasonCode[] = [];
  const floor = anomaly.minimumAbsoluteDeltaPercent;
  const spreadThreshold = baseline.spread * anomaly.thresholdDeviations;
  let threshold = Math.max(floor, spreadThreshold);

  if (baseline.spread === 0) {
    if (anomaly.zeroDenominatorBehaviour === 'insufficient_history') {
      reasons.push(EVIDENCE_REASON_CODES.zeroBaseline);
      return { label: 'insufficient_history', threshold: floor, reasons };
    }
    // A flat baseline means the spread says nothing, so only the absolute
    // floor decides. It never divides by zero and never calls everything a
    // spike because the past happened not to move.
    reasons.push(EVIDENCE_REASON_CODES.zeroBaseline);
    threshold = floor;
  }

  const distance = Math.abs(delta - baseline.centre);
  if (Math.abs(delta) < floor || distance < threshold) {
    return { label: 'normal', threshold, reasons };
  }
  return { label: delta >= 0 ? 'positive_spike' : 'negative_spike', threshold, reasons };
}

/**
 * Labels the most recent observation of each chain target against a rolling
 * baseline of the observations before it.
 */
export function chainAnomalies(
  series: readonly ChainTargetSeries[],
  now: number,
  contract: EvidenceContract = EVIDENCE_CONTRACT,
): AnomalyEntry[] {
  const anomaly = contract.anomaly;
  const entries: AnomalyEntry[] = [];
  const ordered = [...series].sort((a, b) =>
    a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0,
  );

  for (const target of ordered) {
    const observations = [...target.observations]
      .sort((a, b) => a.observedAt - b.observedAt)
      .slice(-anomaly.maximumObservationsPerTarget);
    const latest = observations[observations.length - 1];
    const base = {
      signalType: 'chain_tvl' as const,
      subjectId: target.targetId,
      chain: target.chain,
      protocolSlug: target.protocolSlug,
      dataOrigin: target.dataOrigin,
      provenanceId: target.provenanceId,
      evidenceLimitation: CHAIN_LIMITATION,
    };

    if (latest === undefined) {
      entries.push({
        ...base,
        label: 'missing_observation',
        observationWindow: { startsAt: now, endsAt: now },
        baselineWindow: null,
        value: '0',
        threshold: truncate6(anomaly.minimumAbsoluteDeltaPercent),
        reasonCodes: [EVIDENCE_REASON_CODES.observationMissing],
      });
      continue;
    }

    const observationWindow = {
      startsAt: latest.observedAt - anomaly.observationIntervalHours * 3600,
      endsAt: latest.observedAt,
    };
    const value = truncate6(Number(latest.deltaPercent));

    // Freshness before anything else: an old observation cannot be called a
    // spike, whatever its value, because nothing recent is known.
    if (now - latest.observedAt > anomaly.freshnessLimitHours * 3600) {
      entries.push({
        ...base,
        label: 'stale_observation',
        observationWindow,
        baselineWindow: null,
        value,
        threshold: truncate6(anomaly.minimumAbsoluteDeltaPercent),
        reasonCodes: [EVIDENCE_REASON_CODES.observationStale],
      });
      continue;
    }

    const history = observations.slice(0, -1);
    if (history.length < anomaly.minimumBaselineObservations) {
      entries.push({
        ...base,
        label: 'insufficient_history',
        observationWindow,
        baselineWindow: null,
        value,
        threshold: truncate6(anomaly.minimumAbsoluteDeltaPercent),
        reasonCodes: [EVIDENCE_REASON_CODES.insufficientHistory],
      });
      continue;
    }

    // A gap in the series is reported rather than smoothed over: the baseline
    // would otherwise be computed across a hole nobody was told about.
    const expectedGap = anomaly.observationIntervalHours * 3600;
    const hasGap = observations.some((observation, index) => {
      if (index === 0) return false;
      const previous = observations[index - 1];
      if (previous === undefined) return false;
      return observation.observedAt - previous.observedAt > expectedGap * 2;
    });
    if (hasGap && anomaly.missingObservationBehaviour === 'missing_observation') {
      entries.push({
        ...base,
        label: 'missing_observation',
        observationWindow,
        baselineWindow: {
          startsAt: history[0]?.observedAt ?? observationWindow.startsAt,
          endsAt: history[history.length - 1]?.observedAt ?? observationWindow.startsAt,
        },
        value,
        threshold: truncate6(anomaly.minimumAbsoluteDeltaPercent),
        reasonCodes: [EVIDENCE_REASON_CODES.observationMissing],
      });
      continue;
    }

    const values = history.map((observation) => Number(observation.deltaPercent));
    const baseline = baselineOf(values, anomaly.baselineMethod);
    const decided = labelFor(Number(latest.deltaPercent), baseline, anomaly);
    entries.push({
      ...base,
      label: decided.label,
      observationWindow,
      baselineWindow: {
        startsAt: history[0]?.observedAt ?? observationWindow.startsAt,
        endsAt: history[history.length - 1]?.observedAt ?? observationWindow.startsAt,
      },
      value,
      threshold: truncate6(decided.threshold),
      reasonCodes: decided.reasons,
    });
  }
  return entries;
}

/**
 * Labels the most recent reporting window against the windows before it.
 *
 * The windows are the caller's: explicit start and end instants, or explicit
 * imported batches. Nothing here infers an editorial week, because D10 has not
 * fixed one, and no weekly candidate decision is read as a feature or a label.
 */
export function reportingAnomalies(
  windows: readonly ReportingWindow[],
  contract: EvidenceContract = EVIDENCE_CONTRACT,
): AnomalyEntry[] {
  const rules = contract.reportingAnomaly;
  const ordered = [...windows].sort(
    (a, b) => a.startsAt - b.startsAt || (a.windowId < b.windowId ? -1 : 1),
  );
  const latest = ordered[ordered.length - 1];
  if (latest === undefined) return [];
  const history = ordered.slice(0, -1);
  const base = {
    signalType: 'reporting_volume' as const,
    subjectId: latest.windowId,
    chain: null,
    protocolSlug: null,
    dataOrigin: latest.dataOrigin,
    provenanceId: latest.provenanceId,
    observationWindow: { startsAt: latest.startsAt, endsAt: latest.endsAt },
    evidenceLimitation: REPORTING_LIMITATION,
  };
  const entries: AnomalyEntry[] = [];

  if (history.length < rules.minimumBaselineWindows) {
    entries.push({
      ...base,
      label: 'insufficient_history',
      baselineWindow: null,
      value: String(latest.sourceStoryCount),
      threshold: '0',
      reasonCodes: [EVIDENCE_REASON_CODES.insufficientHistory],
    });
    return entries;
  }

  const baselineWindow = {
    startsAt: history[0]?.startsAt ?? latest.startsAt,
    endsAt: history[history.length - 1]?.endsAt ?? latest.startsAt,
  };
  const counts = history.map((window) => window.sourceStoryCount);
  const baseline = baselineOf(counts, rules.baselineMethod);
  const spread = baseline.spread;
  const threshold =
    spread === 0 && rules.zeroDenominatorBehaviour === 'insufficient_history'
      ? null
      : baseline.centre + spread * rules.thresholdDeviations;

  if (threshold === null) {
    entries.push({
      ...base,
      label: 'insufficient_history',
      baselineWindow,
      value: String(latest.sourceStoryCount),
      threshold: '0',
      reasonCodes: [EVIDENCE_REASON_CODES.zeroBaseline],
    });
  } else {
    const above = latest.sourceStoryCount > threshold;
    const below = latest.sourceStoryCount < baseline.centre - spread * rules.thresholdDeviations;
    entries.push({
      ...base,
      label: above ? 'positive_spike' : below ? 'negative_spike' : 'normal',
      baselineWindow,
      value: String(latest.sourceStoryCount),
      threshold: truncate6(threshold),
      reasonCodes: spread === 0 ? [EVIDENCE_REASON_CODES.zeroBaseline] : [],
    });
  }

  // Concentration: many stories collapsing into few incidents is a different
  // observation from a volume spike, and is reported separately so one cannot
  // be mistaken for the other.
  const storiesPerIncident =
    latest.incidentCount === 0 ? 0 : latest.sourceStoryCount / latest.incidentCount;
  const multiSourceShare =
    latest.incidentCount === 0 ? 0 : latest.multiSourceIncidentCount / latest.incidentCount;
  const concentrated =
    latest.incidentCount > 0 &&
    (storiesPerIncident >= rules.storiesPerIncidentThreshold ||
      multiSourceShare >= rules.multiSourceConcentrationThreshold);
  entries.push({
    ...base,
    subjectId: `${latest.windowId}:concentration`,
    label: concentrated ? 'positive_spike' : 'normal',
    baselineWindow,
    value: truncate6(storiesPerIncident),
    threshold: truncate6(rules.storiesPerIncidentThreshold),
    reasonCodes: latest.incidentCount === 0 ? [EVIDENCE_REASON_CODES.zeroBaseline] : [],
  });
  return entries;
}

/**
 * The combined feed: chain entries and reporting entries in one deterministic
 * order, bounded by the contract.
 *
 * Ordering is by signal type, then label priority, then subject identifier, so
 * two runs over the same input produce the same feed and a reader sees the
 * strongest signals first without the order depending on arrival.
 */
export function anomalyFeed(
  series: readonly ChainTargetSeries[],
  windows: readonly ReportingWindow[],
  now: number,
  contract: EvidenceContract = EVIDENCE_CONTRACT,
): AnomalyFeed {
  const priority: Readonly<Record<AnomalyLabel, number>> = {
    positive_spike: 0,
    negative_spike: 1,
    stale_observation: 2,
    missing_observation: 3,
    insufficient_history: 4,
    normal: 5,
  };
  const rank = (label: AnomalyLabel): number => priority[label] ?? 99;
  const all = [...chainAnomalies(series, now, contract), ...reportingAnomalies(windows, contract)];
  all.sort((a, b) => {
    if (a.signalType !== b.signalType) return a.signalType < b.signalType ? -1 : 1;
    const byLabel = rank(a.label) - rank(b.label);
    if (byLabel !== 0) return byLabel;
    return a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0;
  });
  const bounded = all.slice(0, contract.anomaly.maximumFeedEntries);
  const boundsReached = all.length - bounded.length;
  return {
    entries: bounded,
    stats: {
      chainTargets: series.length,
      reportingWindows: windows.length,
      spikes: bounded.filter((entry) => entry.label.endsWith('_spike')).length,
      insufficientHistory: bounded.filter((entry) => entry.label === 'insufficient_history').length,
      stale: bounded.filter((entry) => entry.label === 'stale_observation').length,
      missing: bounded.filter((entry) => entry.label === 'missing_observation').length,
      boundsReached,
    },
  };
}
