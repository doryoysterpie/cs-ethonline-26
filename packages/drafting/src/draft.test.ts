import { describe, expect, it } from 'vitest';

import { DRAFTING_CONTRACT, draftingContractHash, type DraftingContract } from './contract.js';
import {
  draftFileName,
  generateDraft,
  generateSection,
  serializeProvenance,
  sidecarFileName,
  type DraftClaim,
  type DraftIncident,
  type DraftRequest,
} from './draft.js';

/**
 * The deterministic drafter.
 *
 * Every fixture is synthetic. The organisations, publishers and URLs are
 * invented for the test; nothing here is derived from a published edition or
 * from the real corpus, and no committed test reads either.
 */

function claim(overrides: Partial<DraftClaim> = {}): DraftClaim {
  return {
    claimId: 'claim-1',
    text: 'Kestrelvale Water confirmed that billing systems were offline for three days.',
    confidence: 'confirmed',
    sourceRowIds: ['row-1'],
    victimName: 'Kestrelvale Water',
    victimSupport: 'primary_statement',
    ...overrides,
  };
}

function incident(overrides: Partial<DraftIncident> = {}): DraftIncident {
  return {
    incidentId: 'incident-1',
    clusteringRunId: 'clustering-1',
    batchId: 'batch-1',
    evidenceRunId: 'evidence-1',
    dataOrigin: 'fixture',
    evidenceState: 'reported_only',
    graphEvidence: 'absent',
    onChainSubject: false,
    headline: 'Kestrelvale Water billing outage',
    sources: [
      {
        sourceRowId: 'row-1',
        publisher: 'Example Wire',
        url: 'https://example.test/a',
        publishedAt: null,
      },
      {
        sourceRowId: 'row-2',
        publisher: 'Second Wire',
        url: 'https://example.test/b',
        publishedAt: null,
      },
    ],
    claims: [claim()],
    ...overrides,
  };
}

function request(overrides: Partial<DraftRequest> = {}): DraftRequest {
  return {
    draftId: 'draft-0001',
    periodStart: '2026-06-21T00:00:00.000Z',
    periodEnd: '2026-06-27T23:59:59.000Z',
    dataOrigin: 'replay',
    incidents: [incident()],
    ...overrides,
  };
}

describe('the draft never states more than its input supports', () => {
  it('marks itself unpublished, model-free and labelled by origin', () => {
    const draft = generateDraft(request());
    expect(draft.provenance.status).toBe('unpublished_requires_human_review');
    expect(draft.markdown).toContain('Status: unpublished.');
    expect(draft.markdown).toContain('requires human review');
    expect(draft.markdown).toContain('no model was');
    expect(draft.markdown).toContain('replay (calibration)');
    expect(draft.markdown).not.toContain('AI-generated draft');
  });

  it('omits a claim with no source and says that it did', () => {
    const draft = generateDraft(
      request({
        incidents: [incident({ claims: [claim({ claimId: 'claim-2', sourceRowIds: [] })] })],
      }),
    );
    expect(draft.markdown).toContain('1 claim(s) omitted: no source recorded.');
    expect(draft.markdown).not.toContain('billing systems were offline');
    const record = draft.provenance.claims[0];
    expect(record?.written).toBe(false);
    expect(record?.omissionReason).toBe('claim_without_source');
    expect(draft.provenance.counts.claimsOmitted).toBe(1);
    expect(draft.provenance.counts.claimsWritten).toBe(0);
  });

  it('names a victim on a primary statement and on two independent reports', () => {
    for (const support of ['primary_statement', 'two_independent_reports'] as const) {
      const draft = generateDraft(
        request({ incidents: [incident({ claims: [claim({ victimSupport: support })] })] }),
      );
      expect(draft.markdown, support).toContain('Kestrelvale Water');
      expect(draft.provenance.claims[0]?.namingDecision, support).toBe(
        support === 'primary_statement'
          ? 'named_primary_statement'
          : 'named_two_independent_reports',
      );
      expect(draft.markdown, support).not.toContain('A name is withheld here');
    }
  });

  it('withholds a name on a single report, and says so rather than hiding it', () => {
    for (const support of ['single_report', 'none'] as const) {
      const draft = generateDraft(
        request({ incidents: [incident({ claims: [claim({ victimSupport: support })] })] }),
      );
      expect(draft.markdown, support).not.toContain('Kestrelvale Water billing systems');
      expect(draft.markdown, support).toContain('an organisation that has not been named here');
      expect(draft.markdown, support).toContain('A name is withheld here');
      expect(draft.markdown, support).toContain('decision D4, provisional');
      expect(draft.provenance.claims[0]?.namingDecision, support).toBe(
        'withheld_insufficient_sourcing',
      );
      expect(draft.provenance.counts.namesWithheld, support).toBe(1);
    }
  });

  it('carries the evidence state and the Graph evidence beside every incident', () => {
    const states = [
      ['reported_only', 'no on-chain evidence has been accepted'],
      ['onchain_observed', 'does not establish that this attack occurred'],
      ['corroborated', 'supports a specific claim'],
      ['contradicted', 'conflicts with a specific claim'],
    ] as const;
    for (const [state, sentence] of states) {
      const draft = generateDraft(request({ incidents: [incident({ evidenceState: state })] }));
      expect(draft.markdown, state).toContain(sentence);
      expect(draft.provenance.claims[0]?.evidenceState, state).toBe(state);
    }
    for (const graph of ['absent', 'observed', 'corroborating', 'contradictory'] as const) {
      const draft = generateDraft(request({ incidents: [incident({ graphEvidence: graph })] }));
      expect(draft.markdown, graph).toContain('Graph evidence:');
      expect(draft.provenance.claims[0]?.graphEvidence, graph).toBe(graph);
    }
  });

  it('never smooths a contradiction away', () => {
    const draft = generateDraft(
      request({
        incidents: [incident({ evidenceState: 'contradicted', graphEvidence: 'contradictory' })],
      }),
    );
    expect(draft.markdown).toContain('It is unresolved.');
    expect(draft.markdown).toContain('contradictory, unresolved');
    expect(draft.provenance.counts.contradicted).toBe(1);
  });

  it('applies the house style: US, not U.S.', () => {
    const draft = generateDraft(
      request({
        incidents: [
          incident({
            headline: 'A U.S. utility outage',
            claims: [claim({ text: 'The U.S. operator confirmed the outage.', victimName: null })],
          }),
        ],
      }),
    );
    expect(draft.markdown).toContain('US utility');
    expect(draft.markdown).not.toContain('U.S.');
  });

  it('uses the confidence verb the contract declares', () => {
    for (const [confidence, phrase] of [
      ['confirmed', 'Confirmed:'],
      ['reported', 'Reportedly:'],
      ['suspected', 'Allegedly:'],
    ] as const) {
      const draft = generateDraft(
        request({ incidents: [incident({ claims: [claim({ confidence })] })] }),
      );
      expect(draft.markdown, confidence).toContain(phrase);
    }
  });

  it('places every cited source beneath its incident', () => {
    const draft = generateDraft(
      request({
        incidents: [incident({ claims: [claim({ sourceRowIds: ['row-1', 'row-2'] })] })],
      }),
    );
    expect(draft.markdown).toContain('Sources:');
    expect(draft.markdown).toContain('Example Wire — https://example.test/a');
    expect(draft.markdown).toContain('Second Wire — https://example.test/b');
    expect(draft.provenance.claims[0]?.sourceRowIds).toEqual(['row-1', 'row-2']);
  });
});

describe('sections, ordering and determinism', () => {
  const mixed = (): DraftRequest =>
    request({
      incidents: [
        incident({ incidentId: 'b-plain', evidenceState: 'reported_only' }),
        incident({
          incidentId: 'a-crypto',
          onChainSubject: true,
          evidenceState: 'corroborated',
          graphEvidence: 'corroborating',
          headline: 'Aave v3 value movement beside a reported incident',
        }),
        incident({ incidentId: 'c-contradicted', evidenceState: 'contradicted' }),
      ],
    });

  it('puts on-chain incidents in the crypto section and the rest in incidents', () => {
    const draft = generateDraft(mixed());
    expect(draft.sections.incidents).toContain('Kestrelvale');
    expect(draft.sections.crypto).toContain('## Crypto and Web3');
    expect(draft.sections.crypto).toContain('Aave v3 value movement');
    expect(draft.sections.incidents).not.toContain('Aave v3 value movement');
    expect(draft.provenance.counts.cryptoIncidents).toBe(1);
  });

  it('says plainly when no incident carries an on-chain subject', () => {
    const draft = generateDraft(request());
    expect(draft.sections.crypto).toContain('No incident in this period carries a recorded');
  });

  it('orders incidents by evidence state, then source count, then identifier', () => {
    const draft = generateDraft(mixed());
    const contradicted = draft.sections.incidents.indexOf('conflicts with a specific claim');
    const reported = draft.sections.incidents.indexOf('no on-chain evidence has been accepted');
    expect(contradicted).toBeGreaterThan(-1);
    expect(contradicted).toBeLessThan(reported);
  });

  it('regenerates one section without touching the others', () => {
    const input = mixed();
    const whole = generateDraft(input);
    const again = generateSection('crypto', input);
    expect(again.markdown).toBe(whole.sections.crypto);
    // Changing only a crypto incident leaves the incidents section byte-identical.
    const edited: DraftRequest = {
      ...input,
      incidents: input.incidents.map((entry) =>
        entry.onChainSubject ? { ...entry, headline: 'A different crypto headline' } : entry,
      ),
    };
    const editedDraft = generateDraft(edited);
    expect(editedDraft.sections.incidents).toBe(whole.sections.incidents);
    expect(editedDraft.sections.crypto).not.toBe(whole.sections.crypto);
  });

  it('is invariant to input order and repeats exactly', () => {
    const input = mixed();
    const forward = generateDraft(input);
    const reversed = generateDraft({ ...input, incidents: [...input.incidents].reverse() });
    expect(reversed.markdown).toBe(forward.markdown);
    expect(serializeProvenance(reversed.provenance)).toBe(serializeProvenance(forward.provenance));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(generateDraft(input).markdown).toBe(forward.markdown);
    }
  });

  it('names a dated file per draft, so an earlier one is never overwritten', () => {
    const first = request({ draftId: 'draft-0001' });
    const second = request({ draftId: 'draft-0002' });
    expect(draftFileName(first)).toBe('cyberattack-sunday-2026-06-21-draft-0001.md');
    expect(draftFileName(second)).not.toBe(draftFileName(first));
    expect(sidecarFileName(first)).toBe('cyberattack-sunday-2026-06-21-draft-0001.provenance.json');
  });

  it('takes its period explicitly and never infers one', () => {
    const draft = generateDraft(request());
    expect(draft.markdown).toContain('supplied explicitly');
    expect(draft.provenance.periodStart).toBe('2026-06-21T00:00:00.000Z');
    expect(Object.keys(request()).sort()).toEqual([
      'dataOrigin',
      'draftId',
      'incidents',
      'periodEnd',
      'periodStart',
    ]);
  });

  it('bounds what it will render', () => {
    const bounded: DraftingContract = {
      ...DRAFTING_CONTRACT,
      bounds: { ...DRAFTING_CONTRACT.bounds, maximumIncidents: 1 },
    };
    const draft = generateDraft(mixed(), bounded);
    expect(draft.provenance.counts.incidents).toBe(1);
  });

  it('publishes a stable contract hash', () => {
    expect(draftingContractHash()).toMatch(/^[0-9a-f]{64}$/u);
    expect(new Set(Array.from({ length: 10 }, () => draftingContractHash())).size).toBe(1);
    const changed: DraftingContract = {
      ...DRAFTING_CONTRACT,
      naming: { ...DRAFTING_CONTRACT.naming, genericDescription: 'someone' },
    };
    expect(draftingContractHash(changed)).not.toBe(draftingContractHash());
    const draft = generateDraft(
      request({ incidents: [incident({ claims: [claim({ victimSupport: 'none' })] })] }),
      changed,
    );
    expect(draft.markdown).toContain('someone');
  });

  it('performs no publication and offers no status that could mean published', () => {
    const draft = generateDraft(request());
    expect(draft.provenance.status).toBe('unpublished_requires_human_review');
    const exported = JSON.stringify(draft);
    for (const forbidden of ['publish(', 'POST ', 'substack']) {
      expect(exported.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
