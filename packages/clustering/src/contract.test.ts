import { describe, expect, it } from 'vitest';

import {
  canonicalContract,
  canonicalize,
  CLUSTERING_CONTRACT,
  CLUSTERING_MODE,
  contractHash,
  CONTRACT_VERSION,
  deepFreeze,
  ENGINE_VERSION,
  isDeepFrozen,
  type ClusteringContract,
} from './contract.js';
import { ClusteringBoundError, clusterEligible } from './engine.js';
import { ClusteringInputError, type ClusteringInput } from './input.js';

/**
 * The clustering contract is the executable source of truth, and this file is
 * what holds it to that.
 *
 * Sprint 3's re-audit rejected a contract whose hash moved while the compiled
 * behaviour stood still. Every behaviour field below is therefore paired with
 * a corpus chosen so that changing that field must change an observable
 * result: a cluster, a membership, a fingerprint, a reason code, an ambiguous
 * link or a count. A mutation that changes the hash without changing the
 * result fails here.
 */

type Mutation = (contract: ClusteringContract) => ClusteringContract;

function clone(contract: ClusteringContract): ClusteringContract {
  return JSON.parse(JSON.stringify(contract)) as ClusteringContract;
}

let counter = 0;

function row(overrides: Partial<ClusteringInput> & { id?: string } = {}): ClusteringInput {
  const { id, ...rest } = overrides;
  counter += 1;
  return {
    sourceRowId: id ?? `row-${String(counter).padStart(4, '0')}`,
    rowHash: 'a'.repeat(64),
    classificationResultId: `result-${counter}`,
    classificationRunId: 'run-1',
    batchId: 'batch-1',
    dataOrigin: 'fixture',
    decision: 'include',
    urlGroupId: `group-${counter}`,
    postedAt: null,
    normalizedTitle: null,
    derivedSummaryText: null,
    derivedDescriptionText: null,
    ...rest,
  };
}

/**
 * One corpus that exercises all three stages at once: boilerplate background,
 * an exact duplicate pair, a syndicated pair, a same-incident pair, a
 * different-incident pair that shares only boilerplate, an ambiguous pair, an
 * excluded row and a review row.
 */
function corpus(): ClusteringInput[] {
  const background = Array.from({ length: 30 }, (_, index) =>
    row({
      id: `bg-${String(index).padStart(3, '0')}`,
      urlGroupId: `bg-group-${index}`,
      normalizedTitle: `Company ${index} reports outage affecting services`,
      derivedSummaryText: `Officials described disruption to services and systems for customers in region ${index}.`,
    }),
  );
  return [
    ...background,
    row({ id: 'dup-1', urlGroupId: 'dup', normalizedTitle: 'Kestrelvale Water district notice' }),
    row({ id: 'dup-2', urlGroupId: 'dup', normalizedTitle: 'Kestrelvale Water district notice' }),
    row({
      id: 'syn-1',
      urlGroupId: 'syn-a',
      normalizedTitle:
        'Northwind Clinic confirmed radiology and billing systems in Portland were offline for three days',
    }),
    row({
      id: 'syn-2',
      urlGroupId: 'syn-b',
      normalizedTitle:
        'Northwind Clinic confirmed radiology and billing systems in Portland were offline for three days',
    }),
    row({
      id: 'inc-1',
      urlGroupId: 'inc-a',
      postedAt: '2026-06-01T00:00:00.000Z',
      normalizedTitle: 'Volt Typhoon intrusion halts Eastvale Hospital pharmacy in Bridgeport',
      derivedSummaryText:
        'Eastvale Hospital Bridgeport pharmacy systems disrupted by Volt Typhoon.',
    }),
    row({
      id: 'inc-2',
      urlGroupId: 'inc-b',
      postedAt: '2026-06-02T00:00:00.000Z',
      normalizedTitle: 'Eastvale Hospital Bridgeport pharmacy disrupted by Volt Typhoon',
      derivedSummaryText: 'Volt Typhoon intrusion halted Eastvale pharmacy systems in Bridgeport.',
    }),
    row({
      id: 'amb-1',
      urlGroupId: 'amb-a',
      normalizedTitle: 'Acme Logistics confirms Cl0p stole shipment records',
      derivedSummaryText: 'Acme Logistics told customers Cl0p accessed shipment records in June.',
    }),
    row({
      id: 'amb-2',
      urlGroupId: 'amb-b',
      normalizedTitle: 'Cl0p claims Acme Logistics shipment records',
      derivedSummaryText: 'The Cl0p group listed Acme Logistics and shipment records on its site.',
    }),
    row({
      id: 'rev-1',
      decision: 'review',
      urlGroupId: 'rev',
      normalizedTitle: 'A review candidate',
    }),
    row({
      id: 'exc-1',
      decision: 'exclude',
      urlGroupId: 'exc',
      normalizedTitle: 'An excluded row',
    }),
  ];
}

/** Everything a caller can observe, in a comparable form. */
function observed(contract: ClusteringContract, inputs: readonly ClusteringInput[]): string {
  try {
    const outcome = clusterEligible(inputs, contract);
    return canonicalize({
      clusters: outcome.clusters.map((cluster) => ({
        fingerprint: cluster.fingerprint,
        kind: cluster.kind,
        codes: [...cluster.reasonCodes],
        representative: cluster.representativeSourceRowId,
        members: cluster.members.map((member) => ({
          id: member.sourceRowId,
          duplicate: member.duplicateFingerprint,
          syndication: member.syndicationFingerprint,
        })),
      })),
      links: outcome.ambiguousLinks.map((link) => ({
        left: link.leftFingerprint,
        right: link.rightFingerprint,
        codes: [...link.reasonCodes],
        similarity: link.similarity,
        shared: link.sharedSignals,
        rare: link.sharedRareSignals,
      })),
      stats: { ...outcome.stats },
    });
  } catch (error) {
    if (error instanceof ClusteringInputError) return `rejected:${error.reason}`;
    if (error instanceof ClusteringBoundError) return `rejected:${error.reason}`;
    throw error;
  }
}

type MutationCase = readonly [
  name: string,
  mutate: Mutation,
  inputs?: () => readonly ClusteringInput[],
];

const BEHAVIOUR_MUTATIONS: readonly MutationCase[] = [
  ['eligible decisions', (c) => ({ ...clone(c), eligibleDecisions: ['include'] })],
  ['allowed input keys', (c) => ({ ...clone(c), allowedInputKeys: [] })],
  [
    'allowed input key shape',
    (c) => {
      const next = clone(c);
      return {
        ...next,
        allowedInputKeys: next.allowedInputKeys.map((field) =>
          field.key === 'postedAt' ? { ...field, kind: 'identifier' as const } : field,
        ),
      };
    },
  ],
  [
    // Shingles span the field boundary, so the order the fields are joined in
    // decides which four-token sequences exist. One row splits the wording
    // across two fields and the other carries it whole; reordering the fields
    // breaks the match between them.
    'text assembly: field order',
    (c) => {
      const next = clone(c);
      return {
        ...next,
        textAssembly: {
          ...next.textAssembly,
          fieldOrder: ['derivedSummaryText', 'normalizedTitle', 'derivedDescriptionText'],
        },
      };
    },
    () => [
      row({
        id: 'fo-1',
        urlGroupId: 'fo-a',
        normalizedTitle: 'Kestrelvale Water district issued',
        derivedSummaryText: 'a Bridgeport notice about pharmacy systems today',
      }),
      row({
        id: 'fo-2',
        urlGroupId: 'fo-b',
        normalizedTitle:
          'Kestrelvale Water district issued a Bridgeport notice about pharmacy systems today',
      }),
    ],
  ],
  [
    'text assembly: Unicode form',
    (c) => {
      const next = clone(c);
      return {
        ...next,
        textAssembly: { ...next.textAssembly, unicodeNormalizationForm: 'NFKC' },
      };
    },
    () => [
      row({
        id: 'uu-1',
        urlGroupId: 'uu-a',
        normalizedTitle: 'ｋｅｓｔｒｅｌｖａｌｅ ｗａｔｅｒ ｄｉｓｔｒｉｃｔ ｎｏｔｉｃｅ',
      }),
      row({ id: 'uu-2', urlGroupId: 'uu-b', normalizedTitle: 'kestrelvale water district notice' }),
    ],
  ],
  [
    'text assembly: case normalization',
    (c) => {
      const next = clone(c);
      return { ...next, textAssembly: { ...next.textAssembly, caseNormalization: 'none' } };
    },
    () => [
      row({
        id: 'cc-1',
        urlGroupId: 'cc-a',
        normalizedTitle: 'Kestrelvale Water District Bridgeport Notice Today',
      }),
      row({
        id: 'cc-2',
        urlGroupId: 'cc-b',
        normalizedTitle: 'kestrelvale water district bridgeport notice today',
      }),
    ],
  ],
  [
    'text assembly: input character limit',
    (c) => {
      const next = clone(c);
      return { ...next, textAssembly: { ...next.textAssembly, maxInputCharacters: 24 } };
    },
  ],
  [
    'tokenization: token pattern',
    (c) => {
      const next = clone(c);
      return { ...next, tokenization: { ...next.tokenization, tokenPattern: '[\\p{L}]+' } };
    },
  ],
  [
    'tokenization: minimum token length',
    (c) => {
      const next = clone(c);
      return { ...next, tokenization: { ...next.tokenization, minimumTokenLength: 6 } };
    },
  ],
  [
    'tokenization: maximum tokens',
    (c) => {
      const next = clone(c);
      return { ...next, tokenization: { ...next.tokenization, maximumTokens: 6 } };
    },
  ],
  [
    // Two different incidents whose only shared vocabulary is generic. With
    // the stop list they stay apart; without it the generic words become
    // evidence and they merge, which is the failure the list exists to stop.
    'tokenization: stop terms',
    (c) => {
      const next = clone(c);
      return { ...next, tokenization: { ...next.tokenization, stopTerms: [] } };
    },
    () => [
      ...corpus(),
      row({
        id: 'st-1',
        urlGroupId: 'st-a',
        normalizedTitle: 'Cyberattack hits Larkfield after security breach',
        derivedSummaryText: 'Hackers used malware in the attack, security researchers reported.',
      }),
      row({
        id: 'st-2',
        urlGroupId: 'st-b',
        normalizedTitle: 'Cyberattack strikes Marbridge following security breach',
        derivedSummaryText: 'The attack used malware, security researchers reported afterwards.',
      }),
    ],
  ],
  [
    // A six-token report yields shingles at size four and none at size eight,
    // so the size decides whether the two can be called the same reporting.
    'fingerprint: shingle size',
    (c) => {
      const next = clone(c);
      return { ...next, fingerprint: { ...next.fingerprint, shingleSize: 8 } };
    },
    () => [
      row({
        id: 'sh-1',
        urlGroupId: 'sh-a',
        normalizedTitle: 'Kestrelvale Water district issued Bridgeport notice',
      }),
      row({
        id: 'sh-2',
        urlGroupId: 'sh-b',
        normalizedTitle: 'Kestrelvale Water district issued Bridgeport notice',
      }),
    ],
  ],
  [
    // Two reports differing only in their opening word. Reading every shingle
    // finds the shared body; reading only the first two finds nothing but the
    // difference.
    'fingerprint: maximum shingles',
    (c) => {
      const next = clone(c);
      return { ...next, fingerprint: { ...next.fingerprint, maximumShingles: 2 } };
    },
    () => {
      const body =
        'Kestrelvale Water district issued a Bridgeport notice about pharmacy systems late today';
      return [
        row({ id: 'ms-1', urlGroupId: 'ms-a', normalizedTitle: `Alpha ${body}` }),
        row({ id: 'ms-2', urlGroupId: 'ms-b', normalizedTitle: `Zulu ${body}` }),
      ];
    },
  ],
  [
    'fingerprint: component separator',
    (c) => {
      const next = clone(c);
      return { ...next, fingerprint: { ...next.fingerprint, componentSeparator: '|' } };
    },
  ],
  [
    'fingerprint: digest length',
    (c) => {
      const next = clone(c);
      return { ...next, fingerprint: { ...next.fingerprint, digestLength: 16 } };
    },
  ],
  [
    'fingerprint: algorithm',
    (c) => {
      const next = clone(c);
      return {
        ...next,
        fingerprint: { ...next.fingerprint, algorithm: 'sha512' as 'sha256' },
      };
    },
  ],
  [
    'similarity: function',
    (c) => {
      const next = clone(c);
      return { ...next, similarity: { ...next.similarity, function: 'containment' } };
    },
  ],
  [
    // The same body behind two URLs with one word changed: comfortably above
    // the shipped threshold, and below a threshold of near-identity.
    'similarity: syndication threshold',
    (c) => {
      const next = clone(c);
      return { ...next, similarity: { ...next.similarity, syndicationThreshold: 0.999 } };
    },
    () => {
      const body =
        'Kestrelvale Water district issued a Bridgeport notice about pharmacy systems late today';
      return [
        row({ id: 'sy-1', urlGroupId: 'sy-a', normalizedTitle: `Alpha ${body}` }),
        row({ id: 'sy-2', urlGroupId: 'sy-b', normalizedTitle: `Zulu ${body}` }),
      ];
    },
  ],
  [
    'similarity: incident threshold',
    (c) => {
      const next = clone(c);
      return { ...next, similarity: { ...next.similarity, incidentThreshold: 0.99 } };
    },
  ],
  [
    // A pair that misses both criteria yet sits just under the threshold: the
    // margin alone decides whether a human ever sees it.
    'similarity: ambiguous margin',
    (c) => {
      const next = clone(c);
      return { ...next, similarity: { ...next.similarity, ambiguousMargin: 0 } };
    },
    () => [
      row({
        id: 'am-1',
        urlGroupId: 'am-a',
        normalizedTitle: 'Kestrelvale Water Bridgeport notice',
      }),
      row({
        id: 'am-2',
        urlGroupId: 'am-b',
        normalizedTitle: 'Kestrelvale Water Marbridge bulletin',
      }),
    ],
  ],
  [
    'blocking: keys per item',
    (c) => {
      const next = clone(c);
      return { ...next, blocking: { ...next.blocking, keysPerItem: 0 } };
    },
  ],
  [
    'blocking: maximum block size',
    (c) => {
      const next = clone(c);
      return { ...next, blocking: { ...next.blocking, maximumBlockSize: 1 } };
    },
  ],
  [
    'blocking: comparison budget',
    (c) => {
      const next = clone(c);
      return { ...next, blocking: { ...next.blocking, maximumComparisonsPerItem: 0 } };
    },
  ],
  [
    'blocking: document frequency ratio',
    (c) => {
      const next = clone(c);
      return { ...next, blocking: { ...next.blocking, maximumDocumentFrequencyRatio: 1 } };
    },
  ],
  [
    'incident: minimum shared distinctive tokens',
    (c) => {
      const next = clone(c);
      return { ...next, incident: { ...next.incident, minimumSharedDistinctiveTokens: 40 } };
    },
  ],
  [
    'incident: minimum distinctive token length',
    (c) => {
      const next = clone(c);
      return { ...next, incident: { ...next.incident, minimumDistinctiveTokenLength: 12 } };
    },
  ],
  [
    'incident: minimum shared rare tokens',
    (c) => {
      const next = clone(c);
      return { ...next, incident: { ...next.incident, minimumSharedRareTokens: 40 } };
    },
  ],
  [
    // Two reports that share one rare word and a page of boilerplate. Under
    // the shipped ratio the boilerplate is not rare, so one shared rare word
    // is not enough; call everything rare and they merge on boilerplate.
    'incident: rare token frequency ratio',
    (c) => {
      const next = clone(c);
      return { ...next, incident: { ...next.incident, rareTokenDocumentFrequencyRatio: 1 } };
    },
    () => [
      ...corpus(),
      row({
        id: 'rt-1',
        urlGroupId: 'rt-a',
        normalizedTitle: 'Kestrelvale reports outage affecting services',
        derivedSummaryText:
          'Officials described disruption to services and systems for customers in region alpha.',
      }),
      row({
        id: 'rt-2',
        urlGroupId: 'rt-b',
        // The same vocabulary, rearranged, so the pair is not syndication and
        // reaches the incident stage where rarity decides.
        normalizedTitle: 'Services affected by an outage, Kestrelvale reports',
        derivedSummaryText:
          'Customers in region beta saw systems disruption; officials described the services impact.',
      }),
    ],
  ],
  [
    'incident: time window',
    (c) => {
      const next = clone(c);
      return { ...next, incident: { ...next.incident, timeWindowHours: 1 } };
    },
  ],
  [
    'incident: missing timestamp behaviour',
    (c) => {
      const next = clone(c);
      return { ...next, incident: { ...next.incident, missingTimestampBehaviour: 'separate' } };
    },
    () => [
      ...corpus().filter((input) => !input.sourceRowId.startsWith('inc-')),
      row({
        id: 'nt-1',
        urlGroupId: 'nt-a',
        postedAt: null,
        normalizedTitle: 'Volt Typhoon intrusion halts Eastvale Hospital pharmacy in Bridgeport',
        derivedSummaryText:
          'Eastvale Hospital Bridgeport pharmacy systems disrupted by Volt Typhoon.',
      }),
      row({
        id: 'nt-2',
        urlGroupId: 'nt-b',
        postedAt: null,
        normalizedTitle: 'Eastvale Hospital Bridgeport pharmacy disrupted by Volt Typhoon',
        derivedSummaryText:
          'Volt Typhoon intrusion halted Eastvale pharmacy systems in Bridgeport.',
      }),
    ],
  ],
  [
    'incident: conflicting signal behaviour',
    (c) => {
      const next = clone(c);
      return { ...next, incident: { ...next.incident, conflictingSignalBehaviour: 'separate' } };
    },
  ],
  [
    // The earliest report is not the lowest identifier, so the two rules pick
    // different representatives for the same cluster.
    'representative rule',
    (c) => ({ ...clone(c), representative: { rule: 'lowest-id' } }),
    () => [
      row({
        id: 'rp-1',
        urlGroupId: 'rp',
        postedAt: '2026-06-09T00:00:00.000Z',
        normalizedTitle: 'Kestrelvale Water district issued a Bridgeport notice',
      }),
      row({
        id: 'rp-2',
        urlGroupId: 'rp',
        postedAt: '2026-06-01T00:00:00.000Z',
        normalizedTitle: 'Kestrelvale Water district issued a Bridgeport notice',
      }),
    ],
  ],
  [
    'bounds: maximum inputs',
    (c) => {
      const next = clone(c);
      return { ...next, bounds: { ...next.bounds, maximumInputs: 1 } };
    },
  ],
  [
    'bounds: maximum cluster size',
    (c) => {
      const next = clone(c);
      return { ...next, bounds: { ...next.bounds, maximumClusterSize: 1 } };
    },
  ],
  [
    // Two exact-URL duplicate groups carrying identical reporting, 300 rows
    // each. Their union weighs 600 rows but only 2 duplicate groups, so the
    // two units disagree about whether the shipped 500 bound permits it.
    'bounds: cluster size unit',
    (c) => {
      const next = clone(c);
      return { ...next, bounds: { ...next.bounds, clusterSizeUnit: 'duplicate-groups' } };
    },
    () => {
      const text =
        'Kestrelvale Water district notified Bridgeport customers after Volt Typhoon disrupted its billing portal';
      return ['ldg-a', 'ldg-b'].flatMap((group) =>
        Array.from({ length: 300 }, (_, index) =>
          row({
            id: `${group}-${String(index).padStart(3, '0')}`,
            urlGroupId: group,
            normalizedTitle: text,
            derivedSummaryText: text,
          }),
        ),
      );
    },
  ],
  [
    // One exact-URL duplicate group already past the shipped bound before any
    // merge is considered: the shipped policy refuses the run, the alternative
    // admits the oversized cluster and records the bound.
    'bounds: oversized duplicate group behaviour',
    (c) => {
      const next = clone(c);
      return {
        ...next,
        bounds: { ...next.bounds, oversizedDuplicateGroupBehaviour: 'admit-and-record' },
      };
    },
    () =>
      Array.from({ length: 501 }, (_, index) =>
        row({
          id: `odg-${String(index).padStart(4, '0')}`,
          urlGroupId: 'odg',
          normalizedTitle: 'Kestrelvale Water district notified Bridgeport customers',
        }),
      ),
  ],
  [
    'bounds: maximum ambiguous links',
    (c) => {
      const next = clone(c);
      return { ...next, bounds: { ...next.bounds, maximumAmbiguousLinks: 0 } };
    },
  ],
];

/** Identity fields. They are hashed deliberately and execute nothing. */
const IDENTITY_MUTATIONS: readonly [name: string, mutate: Mutation][] = [
  ['engine version', (c) => ({ ...clone(c), engineVersion: 'clustering-engine@99' })],
  ['contract version', (c) => ({ ...clone(c), contractVersion: 'contract@99' })],
];

describe('the clustering contract is executed, not described', () => {
  it('publishes a stable identity and a reproducible hash', () => {
    expect(ENGINE_VERSION).toBe('clustering-engine@2');
    expect(CONTRACT_VERSION).toBe('clustering-behavior-contract@2');
    expect(CLUSTERING_MODE).toBe('deterministic');
    expect(contractHash()).toMatch(/^[0-9a-f]{64}$/u);
    expect(new Set(Array.from({ length: 20 }, () => contractHash())).size).toBe(1);
  });

  it('changes an observable result for every behaviour field it hashes', () => {
    const seen = new Map<string, string>();
    for (const [name, mutate, inputs] of BEHAVIOUR_MUTATIONS) {
      const build = inputs ?? corpus;
      const mutated = mutate(CLUSTERING_CONTRACT);
      const hash = contractHash(mutated);
      expect(hash, `${name} must change the hash`).not.toBe(contractHash());
      expect(observed(mutated, build()), `${name} must change what the engine returns`).not.toBe(
        observed(CLUSTERING_CONTRACT, build()),
      );
      const previous = seen.get(hash);
      expect(previous, `${name} collides with ${previous ?? ''}`).toBeUndefined();
      seen.set(hash, name);
    }
    expect(seen.size).toBe(BEHAVIOUR_MUTATIONS.length);
  });

  it('covers every behaviour field the contract declares', () => {
    expect(Object.keys(CLUSTERING_CONTRACT).sort()).toEqual([
      'allowedInputKeys',
      'blocking',
      'bounds',
      'contractVersion',
      'eligibleDecisions',
      'engineVersion',
      'fingerprint',
      'incident',
      'mode',
      'representative',
      'similarity',
      'textAssembly',
      'tokenization',
    ]);
    const covered = BEHAVIOUR_MUTATIONS.map(([name]) => name).join(' | ');
    for (const group of [
      'eligible decisions',
      'allowed input',
      'text assembly',
      'tokenization',
      'fingerprint',
      'similarity',
      'blocking',
      'incident',
      'representative',
      'bounds',
    ]) {
      expect(covered, group).toContain(group);
    }
  });

  it('hashes its identity fields, which execute nothing', () => {
    for (const [name, mutate] of IDENTITY_MUTATIONS) {
      const mutated = mutate(CLUSTERING_CONTRACT);
      expect(contractHash(mutated), name).not.toBe(contractHash());
      expect(observed(mutated, corpus()), name).toBe(observed(CLUSTERING_CONTRACT, corpus()));
    }
  });

  it('ignores irrelevant key order and formatting, and keeps meaningful array order', () => {
    const reordered = {
      bounds: CLUSTERING_CONTRACT.bounds,
      representative: CLUSTERING_CONTRACT.representative,
      incident: CLUSTERING_CONTRACT.incident,
      blocking: CLUSTERING_CONTRACT.blocking,
      similarity: CLUSTERING_CONTRACT.similarity,
      fingerprint: CLUSTERING_CONTRACT.fingerprint,
      tokenization: CLUSTERING_CONTRACT.tokenization,
      textAssembly: CLUSTERING_CONTRACT.textAssembly,
      eligibleDecisions: CLUSTERING_CONTRACT.eligibleDecisions,
      allowedInputKeys: CLUSTERING_CONTRACT.allowedInputKeys,
      mode: CLUSTERING_CONTRACT.mode,
      contractVersion: CLUSTERING_CONTRACT.contractVersion,
      engineVersion: CLUSTERING_CONTRACT.engineVersion,
    } as ClusteringContract;
    expect(contractHash(reordered)).toBe(contractHash());
    const prettied = JSON.parse(JSON.stringify(CLUSTERING_CONTRACT, null, 4)) as ClusteringContract;
    expect(contractHash(prettied)).toBe(contractHash());
    expect(canonicalContract(prettied)).toBe(canonicalContract());
    const reversedKeys = {
      ...clone(CLUSTERING_CONTRACT),
      allowedInputKeys: [...CLUSTERING_CONTRACT.allowedInputKeys].reverse(),
    };
    expect(contractHash(reversedKeys)).not.toBe(contractHash());
  });

  it('canonicalizes deterministically and distinguishes types', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
    expect(canonicalize(null)).not.toBe(canonicalize('null'));
    expect(canonicalize(1)).not.toBe(canonicalize('1'));
    expect(canonicalize({ a: undefined, b: 1 })).toBe(canonicalize({ b: 1 }));
    expect(() => canonicalize(Number.NaN)).toThrowError(TypeError);
    expect(() => canonicalize(() => 1)).toThrowError(TypeError);
  });
});

describe('the production contract cannot be edited or shared by accident', () => {
  it('is deeply frozen', () => {
    expect(isDeepFrozen(CLUSTERING_CONTRACT)).toBe(true);
    expect(Object.isFrozen(CLUSTERING_CONTRACT.tokenization.stopTerms)).toBe(true);
    expect(() => {
      (CLUSTERING_CONTRACT.similarity as { incidentThreshold: number }).incidentThreshold = 0;
    }).toThrowError(TypeError);
    expect(CLUSTERING_CONTRACT.similarity.incidentThreshold).toBe(0.34);
  });

  it('holds no state between calls, so two contracts cannot contaminate each other', () => {
    // The engine builds every matcher and index inside one call and keeps no
    // module-level cache, so interleaving two contracts is safe by
    // construction. This proves it rather than asserting it.
    const strict: ClusteringContract = {
      ...clone(CLUSTERING_CONTRACT),
      similarity: { ...CLUSTERING_CONTRACT.similarity, incidentThreshold: 0.99 },
    };
    const baseline = observed(CLUSTERING_CONTRACT, corpus());
    const strictObserved = observed(strict, corpus());
    expect(strictObserved).not.toBe(baseline);
    expect(observed(CLUSTERING_CONTRACT, corpus())).toBe(baseline);
    expect(observed(strict, corpus())).toBe(strictObserved);
    expect(observed(CLUSTERING_CONTRACT, corpus())).toBe(baseline);
  });

  it('deep-freezes what it is given and reports what is not frozen', () => {
    expect(isDeepFrozen(Object.freeze({ nested: { value: 1 } }))).toBe(false);
    expect(isDeepFrozen(deepFreeze({ nested: { value: 1 } }))).toBe(true);
    expect(isDeepFrozen(null)).toBe(true);
  });
});
