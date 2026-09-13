import { createHash } from 'node:crypto';

import type { NamingDecision } from '@cas/contracts';

/**
 * The drafting contract: house style, the naming policy and the section plan,
 * in an executable and hashed form.
 *
 * **How the style rules were derived.** From two of the owner's published
 * Cyberattack Sunday editions, read for structure only: the 9 to 15 August
 * 2026 edition and the 21 to 27 June 2026 edition. No published text is copied
 * into this repository, and nothing here reproduces an edition. What was
 * taken is shape: the title carries a date range; items run as a flat sequence
 * rather than under category headings; each item leads with the affected
 * organisation in bold, runs one to three sentences, and carries its sources
 * immediately beneath it; and confidence is carried by verb choice, with
 * disclosed and confirmed for established facts and reportedly, allegedly and
 * claimed for everything else.
 *
 * **Two deliberate departures**, recorded because a reader deserves to know
 * where the generator differs from the published voice:
 *
 *   1. *US, not U.S.* The August edition uses `US`; the June edition uses
 *      `U.S.`. The project fixes `US`, so the generator is consistent where
 *      the archive is not.
 *   2. *A separate crypto section.* Neither edition has one; crypto items are
 *      integrated into the sequence. The generator emits a distinct section
 *      because this project can tell which incidents carry an on-chain subject
 *      and the published archive could not.
 *
 * **What the editions map to.** The August edition's stated window matches the
 * CS86 spreadsheet window recorded in `DATA_INPUTS.md`, and the June edition's
 * matches CS79's. That is the whole basis for the mapping: two date ranges
 * agreeing. No row-level correspondence between a spreadsheet and a published
 * item exists, and none is claimed.
 *
 * Every field below is read by the generator at run time.
 */

export const DRAFTING_VERSION = 'deterministic-drafter@1';
export const CONTRACT_VERSION = 'drafting-behavior-contract@1';
export const DRAFTING_MODE = 'deterministic' as const;

/** Sections the generator can emit, in the order they appear. */
export const DRAFT_SECTIONS = ['header', 'incidents', 'crypto', 'provenance'] as const;
export type DraftSection = (typeof DRAFT_SECTIONS)[number];

/** How well sourced a victim name is. Decides the naming outcome under D4. */
export const VICTIM_SUPPORTS = [
  'primary_statement',
  'two_independent_reports',
  'single_report',
  'none',
] as const;
export type VictimSupport = (typeof VICTIM_SUPPORTS)[number];

/** Confidence of one claim, carried into the verb the generator chooses. */
export const CLAIM_CONFIDENCES = ['confirmed', 'reported', 'suspected'] as const;
export type ClaimConfidence = (typeof CLAIM_CONFIDENCES)[number];

export interface NamingContract {
  /**
   * Decision D3/D4 remain provisional, so this is the conservative reading of
   * D4 and is marked as such wherever it is reported. A victim is named only
   * on a primary statement from the victim or two independent credible
   * reports; anything less uses a generic description.
   */
  readonly rule: 'primary-statement-or-two-independent-reports';
  /** Supports that permit a name, mapped to the decision recorded on the claim. */
  readonly permits: Readonly<Record<VictimSupport, NamingDecision>>;
  /** Used in place of a withheld name. Never composed from the source text. */
  readonly genericDescription: string;
  /** Whether a withheld name is stated in the draft rather than silently dropped. */
  readonly discloseWithholding: boolean;
}

export interface StyleContract {
  /** Title, with the date range substituted. */
  readonly titleTemplate: string;
  /** Verb-leading phrase per confidence, chosen from the published voice. */
  readonly confidencePhrases: Readonly<Record<ClaimConfidence, string>>;
  /** Substitutions applied to generated prose, in this order. */
  readonly substitutions: readonly (readonly [pattern: string, replacement: string])[];
  /** Sentences one item may carry before it is truncated with a marker. */
  readonly maximumSentencesPerItem: number;
  /** Label placed on a draft that is not from live data. */
  readonly originLabels: Readonly<Record<string, string>>;
}

export interface DraftBoundsContract {
  readonly maximumIncidents: number;
  readonly maximumClaimsPerIncident: number;
  readonly maximumSourcesPerClaim: number;
}

export interface DraftingContract {
  // Identity. Hashed deliberately; executes nothing.
  readonly draftingVersion: string;
  readonly contractVersion: string;
  readonly mode: 'deterministic';
  // Behaviour.
  readonly sections: readonly DraftSection[];
  readonly style: StyleContract;
  readonly naming: NamingContract;
  readonly bounds: DraftBoundsContract;
  /** Ordering of incidents within a section. Array order is precedence. */
  readonly incidentOrder: readonly ('evidence_state' | 'source_count' | 'incident_id')[];
  /** A claim with fewer sources than this is never written. */
  readonly minimumSourcesPerClaim: number;
}

const CONTRACT: DraftingContract = {
  draftingVersion: DRAFTING_VERSION,
  contractVersion: CONTRACT_VERSION,
  mode: DRAFTING_MODE,
  sections: DRAFT_SECTIONS,
  style: {
    titleTemplate: 'Cyberattack Sunday; {range}',
    confidencePhrases: {
      confirmed: 'confirmed',
      reported: 'reportedly',
      suspected: 'allegedly',
    },
    substitutions: [['U.S.', 'US']],
    maximumSentencesPerItem: 3,
    originLabels: {
      live: 'live',
      replay: 'replay (calibration)',
      fixture: 'fixture (synthetic)',
    },
  },
  naming: {
    rule: 'primary-statement-or-two-independent-reports',
    permits: {
      primary_statement: 'named_primary_statement',
      two_independent_reports: 'named_two_independent_reports',
      single_report: 'withheld_insufficient_sourcing',
      none: 'withheld_insufficient_sourcing',
    },
    genericDescription: 'an organisation that has not been named here',
    discloseWithholding: true,
  },
  bounds: {
    maximumIncidents: 500,
    maximumClaimsPerIncident: 20,
    maximumSourcesPerClaim: 10,
  },
  incidentOrder: ['evidence_state', 'source_count', 'incident_id'],
  minimumSourcesPerClaim: 1,
};

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}

export const DRAFTING_CONTRACT: DraftingContract = deepFreeze(CONTRACT);

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('contract contains a non-finite number');
    return Number.isInteger(value) ? value.toFixed(0) : JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  throw new TypeError('contract contains an unserializable value');
}

export function draftingContractHash(contract: DraftingContract = DRAFTING_CONTRACT): string {
  return createHash('sha256').update(canonicalize(contract), 'utf8').digest('hex');
}
