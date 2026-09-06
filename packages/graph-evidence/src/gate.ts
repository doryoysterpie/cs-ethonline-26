import type { ChainId, TvlDeltaSignal } from '@cas/contracts';

import type { StandardizedTvlReading } from './adapter.js';
import { safeDisplay } from './display.js';
import { GraphProbeError, isGraphProbeError } from './errors.js';
import { evaluateFreshness, type FreshnessResult } from './freshness.js';
import { normalizeNetwork } from './network.js';
import { calculateTvlDelta } from './tvl-delta.js';

/**
 * The executable Graph release gate. Every count here derives from validated
 * provider evidence: what the provider returned for network, protocol type,
 * schema version, slug and deployment, checked against the registry's
 * declared expectations. Configured labels never establish distinctness.
 *
 * Canonical protocol identity is the normalized chain plus the
 * provider-returned slug. The provider name is required display metadata and
 * never contributes to distinctness, so a renamed protocol counts once.
 */

/** Expectations a registry target declares, taken verbatim from a verified live sweep. */
export interface TargetExpectations {
  /** Provider network value, for example `MAINNET` or `BASE`. */
  readonly network: string;
  /** Provider standardized protocol family, for example `LENDING`. */
  readonly protocolType: string;
  /** Provider standardized schema version, for example `3.1.0`. */
  readonly schemaVersion: string;
}

export interface DeploymentTarget {
  /** Stable label used in output; never used for counting. */
  readonly label: string;
  readonly chain: ChainId;
  /** Protocol name as the project refers to it in output. */
  readonly protocol: string;
  /** Registry deployment slug. Compared with, never substituted for, the provider slug. */
  readonly slug: string;
  /** Provider-returned slug observed in the verified sweep; the live slug must equal it. */
  readonly expectedProviderSlug: string;
  readonly subgraphId: string;
  readonly schemaFamily: 'lending';
  readonly expected: TargetExpectations;
}

/** Provider protocol type each declared schema family must report. */
const FAMILY_PROTOCOL_TYPES: Readonly<Record<DeploymentTarget['schemaFamily'], string>> = {
  lending: 'LENDING',
};

/**
 * Reject an inconsistent registry before any query is made: empty expected
 * provider slugs, expected networks that do not normalize to the configured
 * chain, protocol types inconsistent with the declared schema family,
 * duplicate labels and duplicate subgraph IDs.
 */
export function validateRegistry(targets: readonly DeploymentTarget[]): void {
  const seenIds = new Map<string, string>();
  const seenLabels = new Set<string>();
  for (const t of targets) {
    if (t.expectedProviderSlug.trim().length === 0) {
      throw new GraphProbeError(
        'validation',
        'registry target has an empty expected provider slug',
        {
          label: t.label,
        },
      );
    }
    const normalized = normalizeNetwork(t.expected.network);
    if (normalized !== t.chain) {
      throw new GraphProbeError(
        'validation',
        'registry expected network does not normalize to the configured chain',
        { label: t.label, expectedNetwork: t.expected.network, chain: t.chain },
      );
    }
    const familyType = FAMILY_PROTOCOL_TYPES[t.schemaFamily];
    if (t.expected.protocolType !== familyType) {
      throw new GraphProbeError(
        'validation',
        'registry expected protocol type is inconsistent with the declared schema family',
        { label: t.label, schemaFamily: t.schemaFamily, protocolType: t.expected.protocolType },
      );
    }
    const prior = seenIds.get(t.subgraphId);
    if (prior !== undefined) {
      throw new GraphProbeError('validation', 'registry declares the same subgraph ID twice', {
        subgraphId: t.subgraphId,
        labels: [prior, t.label],
      });
    }
    seenIds.set(t.subgraphId, t.label);
    if (seenLabels.has(t.label)) {
      throw new GraphProbeError('validation', 'registry declares the same label twice', {
        label: t.label,
      });
    }
    seenLabels.add(t.label);
  }
}

export interface IdentityMismatch {
  readonly targetLabel: string;
  readonly field: string;
  readonly expected: string;
  readonly received: string;
  readonly subgraphId: string;
}

/** A deployment ID counts as present only when it is a non-empty, non-whitespace string. */
export function presentDeploymentId(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Compare live provider metadata to the registry expectations. Empty array means match. */
export function validateLiveIdentity(
  target: DeploymentTarget,
  reading: StandardizedTvlReading,
): IdentityMismatch[] {
  const mismatches: IdentityMismatch[] = [];
  const check = (field: string, expected: string, received: string): void => {
    if (expected !== received) {
      mismatches.push({
        targetLabel: target.label,
        field,
        expected,
        received,
        subgraphId: target.subgraphId,
      });
    }
  };
  check('protocol.slug', target.expectedProviderSlug, reading.identity.slug);
  check('protocol.network', target.expected.network, reading.identity.network);
  check('protocol.network(normalized)', target.chain, reading.identity.chain);
  check('protocol.type', target.expected.protocolType, reading.identity.protocolType);
  check('protocol.schemaVersion', target.expected.schemaVersion, reading.identity.schemaVersion);
  check('provenance.subgraphId', target.subgraphId, reading.provenance.subgraphId);
  if (presentDeploymentId(reading.provenance.deploymentId) === null) {
    mismatches.push({
      targetLabel: target.label,
      field: '_meta.deployment',
      expected: 'non-empty deployment ID',
      received: 'missing',
      subgraphId: target.subgraphId,
    });
  }
  return mismatches;
}

export interface TargetFailure {
  readonly kind: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface TargetEvaluation {
  readonly target: DeploymentTarget;
  readonly reading: StandardizedTvlReading | null;
  readonly signal: TvlDeltaSignal | null;
  readonly freshness: FreshnessResult | null;
  readonly mismatches: readonly IdentityMismatch[];
  readonly failure: TargetFailure | null;
  /** True only when every validation passed. Only valid evaluations can count toward a gate. */
  readonly valid: boolean;
}

function toFailure(error: unknown, redact: (s: string) => string): TargetFailure {
  if (isGraphProbeError(error)) {
    return { kind: error.kind, message: redact(error.message), details: error.details };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: 'unexpected', message: redact(message), details: {} };
}

/** Evaluate a query failure for a target. */
export function evaluateFailedTarget(
  target: DeploymentTarget,
  error: unknown,
  redact: (s: string) => string,
): TargetEvaluation {
  return {
    target,
    reading: null,
    signal: null,
    freshness: null,
    mismatches: [],
    failure: toFailure(error, redact),
    valid: false,
  };
}

/**
 * Evaluate a successful reading for a target: identity validation against the
 * registry expectations, the TVL-delta calculation, and freshness. Pure.
 */
export function evaluateTarget(
  target: DeploymentTarget,
  reading: StandardizedTvlReading,
  queriedAtSeconds: number,
  redact: (s: string) => string,
): TargetEvaluation {
  const mismatches = validateLiveIdentity(target, reading);
  if (mismatches.length > 0) {
    const first = mismatches[0];
    return {
      target,
      reading,
      signal: null,
      freshness: null,
      mismatches,
      failure: {
        kind: 'validation',
        message: `live identity mismatch on ${first?.field ?? 'unknown field'}`,
        details: {
          targetLabel: target.label,
          subgraphId: target.subgraphId,
          mismatches: mismatches.map((m) => ({
            field: m.field,
            expected: redact(m.expected),
            received: redact(m.received),
          })),
        },
      },
      valid: false,
    };
  }

  let signal: TvlDeltaSignal;
  try {
    signal = calculateTvlDelta({
      protocol: reading.identity,
      observations: reading.observations,
      provenance: reading.provenance,
    });
  } catch (error) {
    return {
      target,
      reading,
      signal: null,
      freshness: null,
      mismatches,
      failure: toFailure(error, redact),
      valid: false,
    };
  }

  const freshness = evaluateFreshness(queriedAtSeconds, signal.current.timestamp);
  if (!freshness.fresh) {
    return {
      target,
      reading,
      signal,
      freshness,
      mismatches,
      failure: {
        kind: 'validation',
        message: `current observation failed freshness: ${freshness.reason}`,
        details: {
          targetLabel: target.label,
          subgraphId: target.subgraphId,
          ageSeconds: freshness.ageSeconds,
          limitSeconds: freshness.limitSeconds,
          skewToleranceSeconds: freshness.skewToleranceSeconds,
        },
      },
      valid: false,
    };
  }

  return { target, reading, signal, freshness, mismatches, failure: null, valid: true };
}

export interface ChainGateOptions {
  readonly chain: ChainId;
  /** Minimum distinct verified identities required. */
  readonly minimum: number;
  /** When true, every configured target must be valid, not just the minimum. */
  readonly requireAll: boolean;
}

export interface ChainGateResult {
  readonly chain: ChainId;
  readonly passed: boolean;
  readonly requireAll: boolean;
  readonly minimum: number;
  readonly configured: number;
  readonly valid: number;
  readonly distinctIdentities: number;
  readonly distinctSubgraphIds: number;
  readonly distinctDeploymentIds: number;
  /** Labels of the targets that counted. */
  readonly counted: readonly string[];
  /** Every reason the gate did not pass; empty when it passed. */
  readonly reasons: readonly string[];
}

/** Canonical protocol identity: normalized chain plus provider-returned slug. Name excluded. */
export function protocolIdentityKey(reading: StandardizedTvlReading): string {
  return `${reading.identity.chain}:${reading.identity.slug}`;
}

/**
 * Count verified live identities for one chain. A target counts only when it
 * is valid, reports the gate's chain, and adds a new canonical identity, a new
 * subgraph ID and a new deployment ID. Duplicates by any of those keys are
 * reported and never counted twice. Reasons are display strings: provider
 * values in them are rendered as safe single-line text.
 */
export function evaluateChainGate(
  evaluations: readonly TargetEvaluation[],
  options: ChainGateOptions,
): ChainGateResult {
  const identities = new Set<string>();
  const subgraphIds = new Set<string>();
  const deploymentIds = new Set<string>();
  const counted: string[] = [];
  const reasons: string[] = [];
  let valid = 0;

  for (const e of evaluations) {
    if (!e.valid || e.reading === null || e.signal === null) {
      reasons.push(
        `${e.target.label}: ${safeDisplay(e.failure?.kind ?? 'invalid')}: ${safeDisplay(e.failure?.message ?? 'no signal')}`,
      );
      continue;
    }
    if (e.reading.identity.chain !== options.chain) {
      reasons.push(
        `${e.target.label}: provider reports ${safeDisplay(e.reading.identity.network)}, gate is ${options.chain}`,
      );
      continue;
    }
    valid += 1;
    const identityKey = protocolIdentityKey(e.reading);
    const deploymentId = presentDeploymentId(e.reading.provenance.deploymentId);
    if (identities.has(identityKey)) {
      reasons.push(
        `${e.target.label}: duplicate provider identity ${safeDisplay(e.reading.identity.slug)}`,
      );
      continue;
    }
    if (subgraphIds.has(e.reading.provenance.subgraphId)) {
      reasons.push(`${e.target.label}: duplicate subgraph ID`);
      continue;
    }
    if (deploymentId === null || deploymentIds.has(deploymentId)) {
      reasons.push(`${e.target.label}: duplicate or missing deployment ID`);
      continue;
    }
    identities.add(identityKey);
    subgraphIds.add(e.reading.provenance.subgraphId);
    deploymentIds.add(deploymentId);
    counted.push(e.target.label);
  }

  const distinct = Math.min(identities.size, subgraphIds.size, deploymentIds.size);
  let passed = distinct >= options.minimum;
  if (options.requireAll && counted.length !== evaluations.length) {
    passed = false;
    reasons.push(
      `${counted.length} of ${evaluations.length} configured targets verified; all are required`,
    );
  }
  if (distinct < options.minimum) {
    reasons.push(`${distinct} distinct verified identities, minimum ${options.minimum}`);
  }

  return {
    chain: options.chain,
    passed,
    requireAll: options.requireAll,
    minimum: options.minimum,
    configured: evaluations.length,
    valid,
    distinctIdentities: identities.size,
    distinctSubgraphIds: subgraphIds.size,
    distinctDeploymentIds: deploymentIds.size,
    counted,
    reasons: passed ? [] : reasons,
  };
}
