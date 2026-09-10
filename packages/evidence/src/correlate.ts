import type { AssociationRelation, ChainId, EvidenceState } from '@cas/contracts';

import {
  EVIDENCE_CONTRACT,
  EVIDENCE_REASON_CODES,
  RELATION_TO_RULE,
  type EvidenceContract,
  type EvidenceReasonCode,
} from './contract.js';

/**
 * Correlation and evidence-state resolution (decision D25).
 *
 * Pure and deterministic: no database, no network, no environment, no model,
 * no clock and no randomness. Every rule comes from the supplied contract.
 *
 * The correlator answers one narrow question: is there an explicitly recorded
 * chain and protocol identity on this incident that equals the identity a
 * Graph signal carries, within the declared time window, at a movement large
 * enough to be worth a human's attention? It never reads a headline, a
 * summary, a body or any other text, so no amount of the words "hack",
 * "attack" or "crypto" can produce a link. An incident with no explicitly
 * recorded protocol simply cannot be correlated, and that is the intended
 * outcome rather than a gap.
 *
 * What it produces is a *suggestion*. Under the shipped contract a suggestion
 * is not evidence: a human accepts or rejects it, and only an accepted
 * association reaches the resolver. That is the mechanism that stops a value
 * movement from quietly turning a report into a confirmed cyberattack.
 */

/** What an incident says about itself, with no text of any kind. */
export interface IncidentSubject {
  readonly incidentId: string;
  readonly clusteringRunId: string;
  readonly batchId: string;
  /** Explicitly recorded chain, or null when the incident names none. */
  readonly chain: ChainId | null;
  /**
   * Explicitly recorded protocol identity, normalized by the caller with the
   * same rule `@cas/graph-evidence` uses for provider slugs, or null.
   */
  readonly protocolSlug: string | null;
  /** Earliest reported instant for the incident, Unix seconds. */
  readonly earliestReportedAt: number | null;
  /** Falsifiable claims a signal could support or conflict with. */
  readonly claimIds: readonly string[];
}

/** What a stored Graph signal says about itself, with no provider payload. */
export interface SignalSubject {
  readonly signalId: string;
  readonly signalRunId: string;
  readonly chain: ChainId;
  /** Provider-returned slug, as validated by the Sprint 1 identity gate. */
  readonly protocolSlug: string;
  /** Unix seconds of the observation the signal describes. */
  readonly observedAt: number;
  /** Percentage movement as a decimal string, truncated by the producer. */
  readonly deltaPercent: string;
}

export interface CorrelationSuggestion {
  readonly incidentId: string;
  readonly signalId: string;
  readonly claimId: string | null;
  readonly relation: AssociationRelation;
  readonly reasonCodes: readonly EvidenceReasonCode[];
  /** Seconds from the incident's earliest report to the observation. Signed. */
  readonly offsetSeconds: number;
  readonly absoluteDeltaPercent: string;
}

export interface CorrelationRejection {
  readonly incidentId: string;
  readonly signalId: string;
  readonly reasonCodes: readonly EvidenceReasonCode[];
}

export interface CorrelationOutcome {
  readonly suggestions: readonly CorrelationSuggestion[];
  /** Pairs considered and refused, so a reviewer can see what was not linked. */
  readonly rejections: readonly CorrelationRejection[];
  readonly stats: {
    readonly incidents: number;
    readonly signals: number;
    readonly considered: number;
    readonly suggested: number;
    readonly boundsReached: number;
  };
}

/** Absolute value of a truncated decimal string, without floating point. */
function absoluteDecimal(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value;
}

/**
 * Compares an absolute decimal string against a numeric floor without
 * converting the string to a float first: the integer part decides unless the
 * comparison is genuinely inside one unit.
 */
function atLeast(absolute: string, floor: number): boolean {
  const parsed = Number(absolute);
  if (!Number.isFinite(parsed)) return false;
  return parsed >= floor;
}

/**
 * Suggests associations between incidents and signals.
 *
 * Every pair is considered against the contract in a fixed order, and both
 * outcomes are returned: what was suggested and what was refused with why.
 * Ordering is by incident then signal identifier, so the result never depends
 * on the order the caller supplied.
 */
export function correlate(
  incidents: readonly IncidentSubject[],
  signals: readonly SignalSubject[],
  contract: EvidenceContract = EVIDENCE_CONTRACT,
): CorrelationOutcome {
  const rules = contract.correlation;
  if (incidents.length > contract.bounds.maximumIncidentsPerRun) {
    throw new RangeError('more incidents than the evidence contract permits');
  }
  if (signals.length > contract.bounds.maximumSignalsPerRun) {
    throw new RangeError('more signals than the evidence contract permits');
  }
  const orderedIncidents = [...incidents].sort((a, b) =>
    a.incidentId < b.incidentId ? -1 : a.incidentId > b.incidentId ? 1 : 0,
  );
  const orderedSignals = [...signals].sort((a, b) =>
    a.signalId < b.signalId ? -1 : a.signalId > b.signalId ? 1 : 0,
  );

  const suggestions: CorrelationSuggestion[] = [];
  const rejections: CorrelationRejection[] = [];
  let considered = 0;
  let boundsReached = 0;

  for (const incident of orderedIncidents) {
    for (const signal of orderedSignals) {
      considered += 1;
      const reasons: EvidenceReasonCode[] = [];

      // Identity first. The match rule is the whole mechanism, and only one
      // mechanism exists: explicit chain plus explicit protocol.
      if (rules.matchRule !== 'explicit_chain_and_protocol') {
        throw new TypeError('evidence contract declares an unknown correlation match rule');
      }
      if (incident.protocolSlug === null) {
        reasons.push(EVIDENCE_REASON_CODES.protocolNotNamed);
      } else if (incident.chain === null || incident.chain !== signal.chain) {
        reasons.push(EVIDENCE_REASON_CODES.chainMismatch);
      } else if (incident.protocolSlug !== signal.protocolSlug) {
        reasons.push(EVIDENCE_REASON_CODES.protocolNotNamed);
      }

      // Time next, and only when an identity match survived.
      let offsetSeconds = 0;
      if (reasons.length === 0) {
        if (incident.earliestReportedAt === null) {
          reasons.push(EVIDENCE_REASON_CODES.signalOutsideWindow);
        } else {
          offsetSeconds = signal.observedAt - incident.earliestReportedAt;
          const before = rules.windowBeforeHours * 3600;
          const after = rules.windowAfterHours * 3600;
          if (offsetSeconds < -before || offsetSeconds > after) {
            reasons.push(EVIDENCE_REASON_CODES.signalOutsideWindow);
          }
        }
      }

      // Magnitude last: a movement too small to notice is not worth a human's
      // time even when the identity and the timing line up.
      const absolute = absoluteDecimal(signal.deltaPercent);
      if (reasons.length === 0 && !atLeast(absolute, rules.minimumAbsoluteDeltaPercent)) {
        reasons.push(EVIDENCE_REASON_CODES.magnitudeBelowFloor);
      }

      if (reasons.length > 0) {
        rejections.push({
          incidentId: incident.incidentId,
          signalId: signal.signalId,
          reasonCodes: reasons,
        });
        continue;
      }
      if (suggestions.length >= rules.maximumSuggestions) {
        boundsReached += 1;
        continue;
      }
      // A suggestion is `context` and nothing stronger. Relevant activity was
      // observed near a named protocol; whether it supports or conflicts with
      // a specific claim is a judgement the machine does not make.
      suggestions.push({
        incidentId: incident.incidentId,
        signalId: signal.signalId,
        claimId: null,
        relation: 'context',
        reasonCodes: [EVIDENCE_REASON_CODES.relevantActivityObserved],
        offsetSeconds,
        absoluteDeltaPercent: absolute,
      });
    }
  }

  return {
    suggestions,
    rejections,
    stats: {
      incidents: orderedIncidents.length,
      signals: orderedSignals.length,
      considered,
      suggested: suggestions.length,
      boundsReached,
    },
  };
}

/** One association as the resolver reads it: decided, not proposed. */
export interface AcceptedAssociation {
  readonly incidentId: string;
  readonly signalId: string;
  readonly claimId: string | null;
  readonly relation: AssociationRelation;
  /** `suggested` associations are ignored unless the contract says otherwise. */
  readonly status: 'suggested' | 'accepted' | 'rejected';
}

export interface EvidenceResolution {
  readonly incidentId: string;
  readonly state: EvidenceState;
  readonly reason: EvidenceReasonCode;
  /** The claim the state is about, when the deciding association named one. */
  readonly claimId: string | null;
  /** Associations that counted towards this resolution. */
  readonly acceptedAssociationIds: readonly string[];
}

/**
 * Resolves one incident's evidence state by walking the contract's ordered
 * rules and taking the first that holds.
 *
 * Two properties matter more than the rest, and both are structural rather
 * than advisory. An association that a human has not accepted contributes
 * nothing, so a machine suggestion cannot move a state. And there is no rule
 * whose condition is "no evidence": the absence of a signal, a stale
 * observation and an empty history all fall through to `reported_only`,
 * because absence of evidence is not evidence against a claim.
 */
export function resolveEvidenceState(
  incidentId: string,
  associations: readonly AcceptedAssociation[],
  contract: EvidenceContract = EVIDENCE_CONTRACT,
): EvidenceResolution {
  const mine = associations.filter((association) => association.incidentId === incidentId);
  const counted = mine.filter((association) =>
    contract.correlation.suggestionIsEvidence
      ? association.status !== 'rejected'
      : association.status === 'accepted',
  );

  for (const rule of contract.resolutionRules) {
    if (rule.when === 'always') {
      return {
        incidentId,
        state: rule.state,
        reason: rule.reason,
        claimId: null,
        acceptedAssociationIds: [],
      };
    }
    const matching = counted
      .filter((association) => RELATION_TO_RULE[association.relation] === rule.when)
      .sort((a, b) => (a.signalId < b.signalId ? -1 : a.signalId > b.signalId ? 1 : 0));
    if (matching.length === 0) continue;
    return {
      incidentId,
      state: rule.state,
      reason: rule.reason,
      claimId: matching[0]?.claimId ?? null,
      acceptedAssociationIds: matching.map((association) => association.signalId),
    };
  }
  throw new TypeError('evidence contract has no rule that applies to this incident');
}
