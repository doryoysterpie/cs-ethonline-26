import { describe, expect, it } from 'vitest';

import { EVIDENCE_CONTRACT, EVIDENCE_REASON_CODES, type EvidenceContract } from './contract.js';
import {
  correlate,
  resolveEvidenceState,
  type AcceptedAssociation,
  type IncidentSubject,
  type SignalSubject,
} from './correlate.js';

/**
 * Correlation and evidence-state resolution.
 *
 * Every fixture is synthetic. The protocols are the seven real standardized
 * TVL identities because the correlator matches on identity and nothing else,
 * but no figure here comes from a provider: the deltas are invented for the
 * test.
 */

const HOUR = 3600;
const REPORTED_AT = 1_757_000_000;

function incident(overrides: Partial<IncidentSubject> = {}): IncidentSubject {
  return {
    incidentId: 'incident-1',
    clusteringRunId: 'clustering-1',
    batchId: 'batch-1',
    chain: 'ethereum',
    protocolSlug: 'aave-v3',
    earliestReportedAt: REPORTED_AT,
    claimIds: ['claim-1'],
    ...overrides,
  };
}

function signal(overrides: Partial<SignalSubject> = {}): SignalSubject {
  return {
    signalId: 'signal-1',
    signalRunId: 'signal-run-1',
    chain: 'ethereum',
    protocolSlug: 'aave-v3',
    observedAt: REPORTED_AT + 6 * HOUR,
    deltaPercent: '-18.500000',
    ...overrides,
  };
}

function reasons(outcome: ReturnType<typeof correlate>): string[] {
  return outcome.rejections.flatMap((rejection) => [...rejection.reasonCodes]);
}

describe('correlation matches on explicit identity and nothing else', () => {
  it('suggests a link when chain, protocol, window and magnitude all hold', () => {
    const outcome = correlate([incident()], [signal()]);
    expect(outcome.suggestions).toHaveLength(1);
    const suggestion = outcome.suggestions[0];
    expect(suggestion?.relation).toBe('context');
    expect(suggestion?.offsetSeconds).toBe(6 * HOUR);
    expect(suggestion?.absoluteDeltaPercent).toBe('18.500000');
    // A suggestion never names a claim: which claim a movement bears on is a
    // human judgement, so the machine leaves it null.
    expect(suggestion?.claimId).toBeNull();
    expect(suggestion?.reasonCodes).toEqual([EVIDENCE_REASON_CODES.relevantActivityObserved]);
  });

  it('refuses an incident that names no protocol, however well the timing fits', () => {
    const outcome = correlate([incident({ protocolSlug: null })], [signal()]);
    expect(outcome.suggestions).toHaveLength(0);
    expect(reasons(outcome)).toContain(EVIDENCE_REASON_CODES.protocolNotNamed);
  });

  it('refuses a different chain and a different protocol', () => {
    const wrongChain = correlate([incident({ chain: 'base' })], [signal()]);
    expect(wrongChain.suggestions).toHaveLength(0);
    expect(reasons(wrongChain)).toContain(EVIDENCE_REASON_CODES.chainMismatch);

    const wrongProtocol = correlate([incident({ protocolSlug: 'moonwell' })], [signal()]);
    expect(wrongProtocol.suggestions).toHaveLength(0);
    expect(reasons(wrongProtocol)).toContain(EVIDENCE_REASON_CODES.protocolNotNamed);
  });

  it('cannot be moved by text, because it reads none', () => {
    // The subject type carries no headline, summary or body. An incident whose
    // reporting is full of "hack", "attack" and "crypto" is represented here
    // exactly as one whose reporting is not, so those words can change
    // nothing. Two incidents differing only in identifier behave identically.
    const a = correlate([incident({ incidentId: 'hack-attack-crypto' })], [signal()]);
    const b = correlate([incident({ incidentId: 'incident-1' })], [signal()]);
    expect(a.suggestions).toHaveLength(1);
    expect(b.suggestions).toHaveLength(1);
    expect(Object.keys(incident()).sort()).toEqual([
      'batchId',
      'chain',
      'claimIds',
      'clusteringRunId',
      'earliestReportedAt',
      'incidentId',
      'protocolSlug',
    ]);
  });

  it('holds the time window at its declared edges', () => {
    const before = EVIDENCE_CONTRACT.correlation.windowBeforeHours;
    const after = EVIDENCE_CONTRACT.correlation.windowAfterHours;
    const atAfterEdge = correlate(
      [incident()],
      [signal({ observedAt: REPORTED_AT + after * HOUR })],
    );
    expect(atAfterEdge.suggestions).toHaveLength(1);
    const pastAfterEdge = correlate(
      [incident()],
      [signal({ observedAt: REPORTED_AT + after * HOUR + 1 })],
    );
    expect(pastAfterEdge.suggestions).toHaveLength(0);
    expect(reasons(pastAfterEdge)).toContain(EVIDENCE_REASON_CODES.signalOutsideWindow);

    const atBeforeEdge = correlate(
      [incident()],
      [signal({ observedAt: REPORTED_AT - before * HOUR })],
    );
    expect(atBeforeEdge.suggestions).toHaveLength(1);
    const pastBeforeEdge = correlate(
      [incident()],
      [signal({ observedAt: REPORTED_AT - before * HOUR - 1 })],
    );
    expect(pastBeforeEdge.suggestions).toHaveLength(0);
  });

  it('refuses an incident with no reported instant rather than guessing one', () => {
    const outcome = correlate([incident({ earliestReportedAt: null })], [signal()]);
    expect(outcome.suggestions).toHaveLength(0);
    expect(reasons(outcome)).toContain(EVIDENCE_REASON_CODES.signalOutsideWindow);
  });

  it('refuses a movement below the material floor, in either direction', () => {
    const floor = EVIDENCE_CONTRACT.correlation.minimumAbsoluteDeltaPercent;
    for (const delta of [`${floor - 0.1}`, `-${floor - 0.1}`, '0', '0.000001']) {
      const outcome = correlate([incident()], [signal({ deltaPercent: delta })]);
      expect(outcome.suggestions, delta).toHaveLength(0);
      expect(reasons(outcome), delta).toContain(EVIDENCE_REASON_CODES.magnitudeBelowFloor);
    }
    // At the floor exactly, and negative, it is material.
    expect(
      correlate([incident()], [signal({ deltaPercent: `-${floor}` })]).suggestions,
    ).toHaveLength(1);
  });

  it('is invariant to input order and repeats exactly', () => {
    const incidents = [incident({ incidentId: 'b' }), incident({ incidentId: 'a' })];
    const signals = [signal({ signalId: 'y' }), signal({ signalId: 'x' })];
    const shape = (outcome: ReturnType<typeof correlate>): string =>
      JSON.stringify(outcome.suggestions.map((s) => [s.incidentId, s.signalId]));
    const forward = correlate(incidents, signals);
    expect(shape(correlate([...incidents].reverse(), [...signals].reverse()))).toBe(shape(forward));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(shape(correlate(incidents, signals))).toBe(shape(forward));
    }
    expect(forward.suggestions.map((s) => `${s.incidentId}:${s.signalId}`)).toEqual([
      'a:x',
      'a:y',
      'b:x',
      'b:y',
    ]);
  });

  it('bounds the suggestions it emits and records that it did', () => {
    const bounded: EvidenceContract = {
      ...EVIDENCE_CONTRACT,
      correlation: { ...EVIDENCE_CONTRACT.correlation, maximumSuggestions: 2 },
    };
    const incidents = Array.from({ length: 4 }, (_, index) =>
      incident({ incidentId: `incident-${index}` }),
    );
    const outcome = correlate(incidents, [signal()], bounded);
    expect(outcome.suggestions).toHaveLength(2);
    expect(outcome.stats.boundsReached).toBe(2);
  });

  it('refuses more input than the contract permits', () => {
    const tiny: EvidenceContract = {
      ...EVIDENCE_CONTRACT,
      bounds: { ...EVIDENCE_CONTRACT.bounds, maximumIncidentsPerRun: 1, maximumSignalsPerRun: 1 },
    };
    expect(() =>
      correlate([incident(), incident({ incidentId: 'two' })], [signal()], tiny),
    ).toThrow(RangeError);
    expect(() => correlate([incident()], [signal(), signal({ signalId: 'two' })], tiny)).toThrow(
      RangeError,
    );
  });
});

describe('evidence-state resolution', () => {
  const association = (overrides: Partial<AcceptedAssociation> = {}): AcceptedAssociation => ({
    incidentId: 'incident-1',
    signalId: 'signal-1',
    claimId: 'claim-1',
    relation: 'context',
    status: 'accepted',
    ...overrides,
  });

  it('rests at reported_only with no accepted association', () => {
    const resolved = resolveEvidenceState('incident-1', []);
    expect(resolved.state).toBe('reported_only');
    expect(resolved.reason).toBe(EVIDENCE_REASON_CODES.noAcceptedSignal);
    expect(resolved.acceptedAssociationIds).toEqual([]);
  });

  it('never lets an unaccepted suggestion move the state', () => {
    for (const status of ['suggested', 'rejected'] as const) {
      for (const relation of ['supports', 'conflicts', 'context'] as const) {
        const resolved = resolveEvidenceState('incident-1', [association({ status, relation })]);
        expect(resolved.state, `${status}/${relation}`).toBe('reported_only');
      }
    }
  });

  it('reaches onchain_observed for accepted context, and no further', () => {
    const resolved = resolveEvidenceState('incident-1', [association({ relation: 'context' })]);
    expect(resolved.state).toBe('onchain_observed');
    expect(resolved.reason).toBe(EVIDENCE_REASON_CODES.relevantActivityObserved);
  });

  it('reaches corroborated only for an accepted supporting association, and names its claim', () => {
    const resolved = resolveEvidenceState('incident-1', [
      association({ relation: 'supports', claimId: 'claim-7' }),
    ]);
    expect(resolved.state).toBe('corroborated');
    expect(resolved.claimId).toBe('claim-7');
    expect(resolved.reason).toBe(EVIDENCE_REASON_CODES.claimSupported);
  });

  it('reaches contradicted only for an accepted conflicting association', () => {
    const resolved = resolveEvidenceState('incident-1', [
      association({ relation: 'conflicts', claimId: 'claim-9' }),
    ]);
    expect(resolved.state).toBe('contradicted');
    expect(resolved.claimId).toBe('claim-9');
  });

  it('prefers a conflict over support when both are accepted', () => {
    // Precedence is the contract's rule order, and a conflict outranks
    // support: an unresolved disagreement must stay visible rather than being
    // averaged away into a comfortable answer.
    const resolved = resolveEvidenceState('incident-1', [
      association({ relation: 'supports', signalId: 'a' }),
      association({ relation: 'conflicts', signalId: 'b' }),
    ]);
    expect(resolved.state).toBe('contradicted');
  });

  it('never turns absence, staleness or empty history into a contradiction', () => {
    // Nothing in the resolver's vocabulary can express "no evidence, therefore
    // contradicted": there is no rule whose condition is an absence, so every
    // such case falls through to reported_only.
    for (const associations of [
      [],
      [association({ status: 'suggested' })],
      [association({ status: 'rejected', relation: 'conflicts' })],
    ]) {
      expect(resolveEvidenceState('incident-1', associations).state).toBe('reported_only');
    }
    const conditions = EVIDENCE_CONTRACT.resolutionRules.map((rule) => rule.when);
    expect(conditions).not.toContain('no_evidence');
    expect(
      EVIDENCE_CONTRACT.resolutionRules.filter((r) => r.state === 'contradicted'),
    ).toHaveLength(1);
    expect(EVIDENCE_CONTRACT.resolutionRules[0]?.when).toBe('accepted_conflicting_association');
  });

  it('ignores another incident’s associations', () => {
    const resolved = resolveEvidenceState('incident-1', [
      association({ incidentId: 'incident-2', relation: 'supports' }),
    ]);
    expect(resolved.state).toBe('reported_only');
  });

  it('honours a contract that treats a suggestion as evidence', () => {
    // Not the shipped value. Proven here so the field is executable and so the
    // shipped `false` is a decision rather than an accident.
    const trusting: EvidenceContract = {
      ...EVIDENCE_CONTRACT,
      correlation: { ...EVIDENCE_CONTRACT.correlation, suggestionIsEvidence: true },
    };
    expect(EVIDENCE_CONTRACT.correlation.suggestionIsEvidence).toBe(false);
    const resolved = resolveEvidenceState(
      'incident-1',
      [association({ status: 'suggested', relation: 'supports' })],
      trusting,
    );
    expect(resolved.state).toBe('corroborated');
  });
});
