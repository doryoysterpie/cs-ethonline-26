import { describe, expect, it } from 'vitest';

import { anomalyFeed, type ChainTargetSeries, type ReportingWindow } from './anomaly.js';
import {
  canonicalContract,
  canonicalize,
  CONTRACT_VERSION,
  CORRELATION_POLICY_VERSION,
  deepFreeze,
  EVIDENCE_CONTRACT,
  EVIDENCE_MODE,
  evidenceContractHash,
  isDeepFrozen,
  RESOLVER_VERSION,
  type EvidenceContract,
} from './contract.js';
import {
  correlate,
  resolveEvidenceState,
  type AcceptedAssociation,
  type IncidentSubject,
  type SignalSubject,
} from './correlate.js';

/**
 * The evidence contract is the executable source of truth, and this file holds
 * it to that.
 *
 * Sprints 3 and 4 each had a contract rejected for hashing fields the engine
 * did not read. Every behaviour mutation below is therefore paired with an
 * input chosen so the mutation must change an observable result. A mutation
 * that moves the hash without moving the result fails here.
 */

const HOUR = 3600;
const DAY = 24 * HOUR;
const NOW = 1_757_000_000;
const REPORTED_AT = NOW - 12 * HOUR;

type Mutation = (contract: EvidenceContract) => EvidenceContract;

function clone(contract: EvidenceContract): EvidenceContract {
  return JSON.parse(JSON.stringify(contract)) as EvidenceContract;
}

const INCIDENTS: readonly IncidentSubject[] = [
  {
    incidentId: 'incident-1',
    clusteringRunId: 'clustering-1',
    batchId: 'batch-1',
    chain: 'ethereum',
    protocolSlug: 'aave-v3',
    earliestReportedAt: REPORTED_AT,
    claimIds: ['claim-1'],
  },
];

const SIGNALS: readonly SignalSubject[] = [
  {
    // Observed before the earliest report, so the before-window decides it.
    signalId: 'signal-0',
    signalRunId: 'signal-run-1',
    chain: 'ethereum',
    protocolSlug: 'aave-v3',
    observedAt: REPORTED_AT - 24 * HOUR,
    deltaPercent: '-22.250000',
  },
  {
    signalId: 'signal-1',
    signalRunId: 'signal-run-1',
    chain: 'ethereum',
    protocolSlug: 'aave-v3',
    observedAt: REPORTED_AT + 6 * HOUR,
    deltaPercent: '-18.500000',
  },
];

const ASSOCIATIONS: readonly AcceptedAssociation[] = [
  {
    incidentId: 'incident-1',
    signalId: 'signal-1',
    claimId: 'claim-1',
    relation: 'supports',
    status: 'accepted',
  },
  {
    // Suggested, not accepted. Under the shipped contract it contributes
    // nothing; under a contract that trusts suggestions it would outrank the
    // accepted support above, which is what makes that field executable.
    incidentId: 'incident-1',
    signalId: 'signal-0',
    claimId: 'claim-2',
    relation: 'conflicts',
    status: 'suggested',
  },
];

/** A baseline with genuine spread, so a deviation threshold has something to bite on. */
const VARIED = ['0.4', '-1.1', '2.3', '-0.2', '1.7', '-2.9', '0.8', '3.1', '-1.4'];

function chainSeries(latest: string, count = 10): ChainTargetSeries {
  const end = NOW - HOUR;
  return {
    targetId: 'aave-v3-ethereum',
    chain: 'ethereum',
    protocolSlug: 'aave-v3',
    dataOrigin: 'fixture',
    provenanceId: 'signal-run-1',
    observations: Array.from({ length: count }, (_, index) => ({
      observedAt: end - (count - 1 - index) * DAY,
      deltaPercent: index === count - 1 ? latest : (VARIED[index % VARIED.length] ?? '0.4'),
    })),
  };
}

/** A series with a hole in it, so the missing-observation rule has something to decide. */
function gappedSeries(latest: string): ChainTargetSeries {
  const end = NOW - HOUR;
  const count = 10;
  return {
    targetId: 'spark-lend-ethereum',
    chain: 'ethereum',
    protocolSlug: 'spark-lend',
    dataOrigin: 'fixture',
    provenanceId: 'signal-run-1',
    observations: Array.from({ length: count }, (_, index) => ({
      // A four-day hole in the middle, well past twice the declared interval.
      observedAt: end - (count - 1 - index) * DAY - (index < 5 ? 4 * DAY : 0),
      deltaPercent: index === count - 1 ? latest : (VARIED[index % VARIED.length] ?? '0.4'),
    })),
  };
}

/** A perfectly flat baseline, so the zero-spread rule has something to decide. */
function flatSeries(latest: string, count = 10): ChainTargetSeries {
  const end = NOW - HOUR;
  return {
    targetId: 'moonwell-base',
    chain: 'base',
    protocolSlug: 'moonwell',
    dataOrigin: 'fixture',
    provenanceId: 'signal-run-1',
    observations: Array.from({ length: count }, (_, index) => ({
      observedAt: end - (count - 1 - index) * DAY,
      deltaPercent: index === count - 1 ? latest : '0',
    })),
  };
}

const WINDOWS: readonly ReportingWindow[] = [
  ...[100, 104, 98, 102].map((count, index) => ({
    windowId: `window-${index}`,
    startsAt: NOW - (10 - index) * 7 * DAY,
    endsAt: NOW - (9 - index) * 7 * DAY,
    dataOrigin: 'replay' as const,
    provenanceId: 'batch-1',
    sourceStoryCount: count,
    incidentCount: 80,
    multiSourceIncidentCount: 5,
  })),
  {
    windowId: 'window-latest',
    startsAt: NOW - 7 * DAY,
    endsAt: NOW,
    dataOrigin: 'replay' as const,
    provenanceId: 'batch-1',
    sourceStoryCount: 400,
    incidentCount: 40,
    multiSourceIncidentCount: 20,
  },
];

/** Everything a caller can observe from all three engines, in one string. */
function observed(contract: EvidenceContract): string {
  const correlation = correlate(INCIDENTS, SIGNALS, contract);
  const resolution = resolveEvidenceState('incident-1', ASSOCIATIONS, contract);
  const feed = anomalyFeed(
    [chainSeries('42.5'), flatSeries('30'), gappedSeries('44')],
    WINDOWS,
    NOW,
    contract,
  );
  return canonicalize({
    suggestions: correlation.suggestions.map((s) => ({
      incident: s.incidentId,
      signal: s.signalId,
      relation: s.relation,
      offset: s.offsetSeconds,
      delta: s.absoluteDeltaPercent,
    })),
    rejections: correlation.rejections.map((r) => [...r.reasonCodes]),
    stats: { ...correlation.stats },
    resolution: { state: resolution.state, reason: resolution.reason, claim: resolution.claimId },
    feed: feed.entries.map((entry) => ({
      type: entry.signalType,
      label: entry.label,
      subject: entry.subjectId,
      value: entry.value,
      threshold: entry.threshold,
      codes: [...entry.reasonCodes],
    })),
    feedStats: { ...feed.stats },
  });
}

const BEHAVIOUR_MUTATIONS: readonly [name: string, mutate: Mutation][] = [
  [
    'correlation: window before',
    (c) => ({ ...clone(c), correlation: { ...c.correlation, windowBeforeHours: 0 } }),
  ],
  [
    'correlation: window after',
    (c) => ({ ...clone(c), correlation: { ...c.correlation, windowAfterHours: 1 } }),
  ],
  [
    'correlation: magnitude floor',
    (c) => ({
      ...clone(c),
      correlation: { ...c.correlation, minimumAbsoluteDeltaPercent: 90 },
    }),
  ],
  [
    'correlation: suggestion is evidence',
    (c) => ({ ...clone(c), correlation: { ...c.correlation, suggestionIsEvidence: true } }),
  ],
  [
    'correlation: maximum suggestions',
    (c) => ({ ...clone(c), correlation: { ...c.correlation, maximumSuggestions: 0 } }),
  ],
  [
    'resolution: rule order',
    (c) => ({ ...clone(c), resolutionRules: [...c.resolutionRules].reverse() }),
  ],
  [
    'resolution: the state a rule produces',
    (c) => {
      const next = clone(c);
      return {
        ...next,
        resolutionRules: next.resolutionRules.map((rule) =>
          rule.id === 'supporting_evidence'
            ? { ...rule, state: 'onchain_observed' as const }
            : rule,
        ),
      };
    },
  ],
  [
    'resolution: the reason a rule records',
    (c) => {
      const next = clone(c);
      return {
        ...next,
        resolutionRules: next.resolutionRules.map((rule) =>
          rule.id === 'supporting_evidence'
            ? { ...rule, reason: 'relevant_activity_observed' as const }
            : rule,
        ),
      };
    },
  ],
  [
    'anomaly: observation interval',
    (c) => ({ ...clone(c), anomaly: { ...c.anomaly, observationIntervalHours: 1 } }),
  ],
  [
    'anomaly: minimum baseline observations',
    (c) => ({ ...clone(c), anomaly: { ...c.anomaly, minimumBaselineObservations: 50 } }),
  ],
  [
    'anomaly: baseline method',
    (c) => ({
      ...clone(c),
      anomaly: { ...c.anomaly, baselineMethod: 'mean-standard-deviation' as const },
    }),
  ],
  [
    'anomaly: threshold deviations',
    (c) => ({ ...clone(c), anomaly: { ...c.anomaly, thresholdDeviations: 1000 } }),
  ],
  [
    'anomaly: absolute floor',
    (c) => ({ ...clone(c), anomaly: { ...c.anomaly, minimumAbsoluteDeltaPercent: 90 } }),
  ],
  [
    'anomaly: zero-denominator behaviour',
    (c) => ({
      ...clone(c),
      anomaly: { ...c.anomaly, zeroDenominatorBehaviour: 'insufficient_history' as const },
    }),
  ],
  [
    'anomaly: missing-observation behaviour',
    (c) => ({
      ...clone(c),
      anomaly: { ...c.anomaly, missingObservationBehaviour: 'skip' as const },
    }),
  ],
  [
    'anomaly: freshness limit',
    (c) => ({ ...clone(c), anomaly: { ...c.anomaly, freshnessLimitHours: 0 } }),
  ],
  [
    'anomaly: observations read per target',
    (c) => ({ ...clone(c), anomaly: { ...c.anomaly, maximumObservationsPerTarget: 3 } }),
  ],
  [
    'anomaly: feed entries',
    (c) => ({ ...clone(c), anomaly: { ...c.anomaly, maximumFeedEntries: 1 } }),
  ],
  [
    'reporting: minimum baseline windows',
    (c) => ({
      ...clone(c),
      reportingAnomaly: { ...c.reportingAnomaly, minimumBaselineWindows: 40 },
    }),
  ],
  [
    'reporting: baseline method',
    (c) => ({
      ...clone(c),
      reportingAnomaly: {
        ...c.reportingAnomaly,
        baselineMethod: 'mean-standard-deviation' as const,
      },
    }),
  ],
  [
    'reporting: threshold deviations',
    (c) => ({ ...clone(c), reportingAnomaly: { ...c.reportingAnomaly, thresholdDeviations: 500 } }),
  ],
  [
    'reporting: stories per incident threshold',
    (c) => ({
      ...clone(c),
      reportingAnomaly: { ...c.reportingAnomaly, storiesPerIncidentThreshold: 500 },
    }),
  ],
  [
    'reporting: multi-source concentration threshold',
    (c) => ({
      ...clone(c),
      reportingAnomaly: {
        ...c.reportingAnomaly,
        storiesPerIncidentThreshold: 500,
        multiSourceConcentrationThreshold: 0.99,
      },
    }),
  ],
  [
    'reporting: zero-denominator behaviour',
    (c) => ({
      ...clone(c),
      reportingAnomaly: {
        ...c.reportingAnomaly,
        thresholdDeviations: 0,
        zeroDenominatorBehaviour: 'insufficient_history' as const,
      },
    }),
  ],
  [
    'bounds: maximum incidents per run',
    (c) => ({ ...clone(c), bounds: { ...c.bounds, maximumIncidentsPerRun: 0 } }),
  ],
  [
    'bounds: maximum signals per run',
    (c) => ({ ...clone(c), bounds: { ...c.bounds, maximumSignalsPerRun: 0 } }),
  ],
];

/** Identity fields. Hashed deliberately; they execute nothing. */
const IDENTITY_MUTATIONS: readonly [name: string, mutate: Mutation][] = [
  ['resolver version', (c) => ({ ...clone(c), resolverVersion: 'evidence-resolver@99' })],
  ['contract version', (c) => ({ ...clone(c), contractVersion: 'contract@99' })],
  ['correlation policy version', (c) => ({ ...clone(c), correlationPolicyVersion: 'policy@99' })],
];

/** Observed result, or the fixed rejection an out-of-bounds contract produces. */
function safelyObserved(contract: EvidenceContract): string {
  try {
    return observed(contract);
  } catch (error) {
    return `threw:${(error as Error).name}`;
  }
}

describe('the evidence contract is executed, not described', () => {
  it('publishes a stable identity and a reproducible hash', () => {
    expect(RESOLVER_VERSION).toBe('evidence-resolver@1');
    expect(CONTRACT_VERSION).toBe('evidence-behavior-contract@1');
    expect(CORRELATION_POLICY_VERSION).toBe('graph-correlation-policy@1');
    expect(EVIDENCE_MODE).toBe('deterministic');
    expect(evidenceContractHash()).toMatch(/^[0-9a-f]{64}$/u);
    expect(new Set(Array.from({ length: 20 }, () => evidenceContractHash())).size).toBe(1);
  });

  it('changes an observable result for every behaviour field it hashes', () => {
    // Pinned so the count quoted in docs/SPRINT-5-REPORT.md cannot drift from
    // the list it describes.
    expect(BEHAVIOUR_MUTATIONS.length).toBe(26);
    const baseline = evidenceContractHash();
    const baselineObserved = observed(EVIDENCE_CONTRACT);
    const seen = new Map<string, string>();
    for (const [name, mutate] of BEHAVIOUR_MUTATIONS) {
      const mutated = mutate(EVIDENCE_CONTRACT);
      const hash = evidenceContractHash(mutated);
      expect(hash, `${name} must change the hash`).not.toBe(baseline);
      expect(safelyObserved(mutated), `${name} must change what the engine returns`).not.toBe(
        baselineObserved,
      );
      const previous = seen.get(hash);
      expect(previous, `${name} collides with ${previous ?? ''}`).toBeUndefined();
      seen.set(hash, name);
    }
    expect(seen.size).toBe(BEHAVIOUR_MUTATIONS.length);
  });

  it('covers every behaviour field the contract declares', () => {
    expect(Object.keys(EVIDENCE_CONTRACT).sort()).toEqual([
      'anomaly',
      'bounds',
      'contractVersion',
      'correlation',
      'correlationPolicyVersion',
      'mode',
      'reportingAnomaly',
      'resolutionRules',
      'resolverVersion',
    ]);
    const covered = BEHAVIOUR_MUTATIONS.map(([name]) => name).join(' | ');
    for (const group of ['correlation', 'resolution', 'anomaly', 'reporting', 'bounds']) {
      expect(covered, group).toContain(group);
    }
  });

  it('hashes its identity fields, which execute nothing', () => {
    const baselineObserved = observed(EVIDENCE_CONTRACT);
    for (const [name, mutate] of IDENTITY_MUTATIONS) {
      const mutated = mutate(EVIDENCE_CONTRACT);
      expect(evidenceContractHash(mutated), name).not.toBe(evidenceContractHash());
      expect(observed(mutated), name).toBe(baselineObserved);
    }
  });

  it('ignores irrelevant key order and formatting, and keeps meaningful array order', () => {
    const reordered = {
      bounds: EVIDENCE_CONTRACT.bounds,
      reportingAnomaly: EVIDENCE_CONTRACT.reportingAnomaly,
      anomaly: EVIDENCE_CONTRACT.anomaly,
      resolutionRules: EVIDENCE_CONTRACT.resolutionRules,
      correlation: EVIDENCE_CONTRACT.correlation,
      mode: EVIDENCE_CONTRACT.mode,
      correlationPolicyVersion: EVIDENCE_CONTRACT.correlationPolicyVersion,
      contractVersion: EVIDENCE_CONTRACT.contractVersion,
      resolverVersion: EVIDENCE_CONTRACT.resolverVersion,
    } as EvidenceContract;
    expect(evidenceContractHash(reordered)).toBe(evidenceContractHash());
    const prettied = JSON.parse(JSON.stringify(EVIDENCE_CONTRACT, null, 4)) as EvidenceContract;
    expect(evidenceContractHash(prettied)).toBe(evidenceContractHash());
    expect(canonicalContract(prettied)).toBe(canonicalContract());
    const reversed = {
      ...clone(EVIDENCE_CONTRACT),
      resolutionRules: [...EVIDENCE_CONTRACT.resolutionRules].reverse(),
    };
    expect(evidenceContractHash(reversed)).not.toBe(evidenceContractHash());
  });

  it('canonicalizes deterministically and distinguishes types', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
    expect(canonicalize(null)).not.toBe(canonicalize('null'));
    expect(canonicalize({ a: undefined, b: 1 })).toBe(canonicalize({ b: 1 }));
    expect(() => canonicalize(Number.NaN)).toThrowError(TypeError);
    expect(() => canonicalize(() => 1)).toThrowError(TypeError);
  });

  it('is deeply frozen and holds no state between calls', () => {
    expect(isDeepFrozen(EVIDENCE_CONTRACT)).toBe(true);
    expect(() => {
      (EVIDENCE_CONTRACT.correlation as { windowAfterHours: number }).windowAfterHours = 0;
    }).toThrowError(TypeError);
    expect(EVIDENCE_CONTRACT.correlation.windowAfterHours).toBe(72);
    expect(isDeepFrozen(deepFreeze({ nested: { value: 1 } }))).toBe(true);
    expect(isDeepFrozen(Object.freeze({ nested: { value: 1 } }))).toBe(false);

    // Interleaving two contracts cannot contaminate either.
    const strict: EvidenceContract = {
      ...clone(EVIDENCE_CONTRACT),
      correlation: { ...EVIDENCE_CONTRACT.correlation, minimumAbsoluteDeltaPercent: 90 },
    };
    const base = observed(EVIDENCE_CONTRACT);
    const other = observed(strict);
    expect(other).not.toBe(base);
    expect(observed(EVIDENCE_CONTRACT)).toBe(base);
    expect(observed(strict)).toBe(other);
  });
});
