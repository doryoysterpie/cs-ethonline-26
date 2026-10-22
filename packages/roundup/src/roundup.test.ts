import { describe, expect, it } from 'vitest';

import { canonicalize, sha256 } from './canonical.js';
import {
  costMicrodollars,
  monthKey,
  MONTHLY_CAP_MICRODOLLARS,
  worstCaseMicrodollars,
  wouldExceedCap,
} from './cost.js';
import { isRoundupError } from './errors.js';
import { generateRoundup, prepareGeneration } from './generate.js';
import { assertRoundupInput, inputDigest, publisherOf, type RoundupInput } from './input.js';
import { PROMPT_VERSION, promptHash, systemPrompt } from './prompt.js';
import { deterministicSlots, renderMarkdown } from './render.js';
import { RoundupSlotsSchema, slotsJsonSchema } from './schema.js';
import { loadTemplate, parseTemplate, sectionOf } from './template.js';
import { recordedTransport } from './transport.js';
import { validateResponse } from './validate.js';

/**
 * The round-up contract, offline: the committed template and its hash, the
 * schema, the deterministic rendering, every rejection the validator makes,
 * and one generation through a recorded transport per lane. Every fixture is
 * synthetic. No test opens a socket; the package has nothing that could.
 */

const ids = (n: number): string => `0000000${n}-0000-4000-8000-00000000000${n}`;

function cyberInput(): RoundupInput {
  return {
    weekRunId: '7b9d2f4e-5c1a-4e6b-9f3d-2a8c1e5b7d90',
    category: 'cyberattack',
    windowStart: '2026-10-18T03:59:00.000Z',
    windowEnd: '2026-10-25T03:59:00.000Z',
    incidents: [
      {
        incidentId: ids(1),
        rows: [
          {
            sourceRowId: ids(2),
            title: 'Ransomware halts Harborline Port terminal operations',
            summary:
              'Harborline Port said terminal systems were encrypted overnight and ships were held.',
            url: 'https://news.example/harborline-ransomware',
            publisher: 'news.example',
            postedAt: '2026-10-20T10:00:00.000Z',
          },
          {
            sourceRowId: ids(3),
            title: 'Harborline Port terminal operations disrupted by ransomware',
            summary: 'The port confirmed the intrusion to its terminal systems on Tuesday.',
            url: 'https://wire.example/harborline',
            publisher: 'wire.example',
            postedAt: '2026-10-21T09:00:00.000Z',
          },
        ],
      },
      {
        incidentId: ids(4),
        rows: [
          {
            sourceRowId: ids(5),
            title: 'Brightwater Utility confirms a data breach of customer accounts',
            summary: null,
            url: 'https://news.example/brightwater',
            publisher: 'news.example',
            postedAt: '2026-10-19T08:00:00.000Z',
          },
        ],
      },
    ],
    flagged: [
      {
        incidentId: ids(6),
        headline: 'A slow-cooker recipe for the weekend',
        reason: 'not a cyber story',
        disposition: 'omit',
      },
      {
        incidentId: ids(7),
        headline: 'Kestrelvale Water confirms a breach',
        reason: 'first seen after the freeze; carried per D10',
        disposition: 'carry',
      },
    ],
  };
}

function cryptoInput(): RoundupInput {
  return {
    ...cyberInput(),
    category: 'crypto',
    incidents: [
      {
        incidentId: ids(8),
        rows: [
          {
            sourceRowId: ids(9),
            title: 'Bitcoin exchange halts withdrawals after a wallet drainer hits customers',
            summary: 'The exchange said a drainer targeted customer wallets over the weekend.',
            url: 'https://coins.example/drainer',
            publisher: 'coins.example',
            postedAt: '2026-10-19T15:00:00.000Z',
          },
        ],
      },
    ],
    flagged: [],
  };
}

/** A well-formed model answer for an input: reformatted text, exact sources and citations. */
function goldenFor(input: RoundupInput, marker: string): unknown {
  return {
    rundown: input.incidents.map((incident, i) => ({
      headline: `Reformatted Headline ${i + 1}`,
      summary: `Brace yourself: ${incident.rows[0]?.title ?? ''} and every key detail sits here.`,
      sources: incident.rows.map((row) => row.url),
      citations: incident.rows.map((row) => row.sourceRowId),
    })),
    flagged: input.flagged.map((entry) => ({
      headline: entry.headline,
      reason: entry.reason,
      disposition: entry.disposition,
    })),
    extras: marker,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isRoundupError(error)) return error.code;
    throw error;
  }
  return 'none';
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (isRoundupError(error)) return error.code;
    throw error;
  }
  return 'none';
}

describe('the rundown template (D40)', () => {
  it('loads the committed structure, canonicalizes it and hashes it stably', async () => {
    const loaded = await loadTemplate();
    expect(loaded.template.version).toBe('rundown-template@1');
    expect(loaded.template.sections.map((s) => s.id)).toEqual(['rundown', 'extras', 'flagged']);
    expect(sectionOf(loaded.template, 'extras').manual).toBe(true);
    expect(sectionOf(loaded.template, 'extras').marker).toContain('extras');
    expect(loaded.hash).toBe(sha256(loaded.canonical));
    expect(loaded.canonical).toBe(canonicalize(loaded.template));
    const again = await loadTemplate();
    expect(again.hash).toBe(loaded.hash);
    expect(loaded.template.entry.summary.sentences).toEqual({ min: 1, max: 2 });
    expect(loaded.template.entry.summary.rules.some((r) => r.includes('Canadian spelling'))).toBe(
      true,
    );
  });

  it('refuses a template that is not the structure the generator relies on', async () => {
    const loaded = await loadTemplate();
    const base = JSON.parse(JSON.stringify(loaded.template)) as Record<string, unknown>;
    for (const broken of [
      { ...base, version: 'rundown@one' },
      { ...base, sections: (base['sections'] as unknown[]).slice(0, 2) },
      { ...base, entry: { ...(base['entry'] as Record<string, unknown>), sources: {} } },
      { ...base, deduplication: {} },
      'not an object',
    ]) {
      expect(codeOf(() => parseTemplate(broken))).toBe('template_invalid');
    }
  });
});

describe('the input and the schema', () => {
  it('accepts the snapshot, digests it canonically, and refuses what the contract forbids', () => {
    const input = cyberInput();
    expect(() => assertRoundupInput(input)).not.toThrow();
    expect(inputDigest(input)).toBe(inputDigest({ ...input }));
    expect(inputDigest(input)).not.toBe(inputDigest(cryptoInput()));
    expect(codeOf(() => assertRoundupInput({ ...input, incidents: [] }))).toBe('input_empty');
    expect(codeOf(() => assertRoundupInput({ ...input, category: 'Cyber' }))).toBe('input_invalid');
    const duplicate = {
      ...input,
      incidents: [...input.incidents, input.incidents[0] as (typeof input.incidents)[number]],
    };
    expect(codeOf(() => assertRoundupInput(duplicate))).toBe('input_invalid');
    expect(publisherOf('https://News.Example/path?x=1')).toBe('news.example');
    expect(publisherOf('not a url')).toBe('unknown');
  });

  it('describes the slots as a closed schema with bounds', () => {
    const schema = slotsJsonSchema();
    expect(schema).toHaveProperty('properties');
    expect(RoundupSlotsSchema.safeParse({ rundown: [], flagged: [], extras: 'x' }).success).toBe(
      false,
    );
    expect(
      RoundupSlotsSchema.safeParse({
        rundown: [{ headline: 'h', summary: 's', sources: ['u'], citations: [ids(1)], extra: 1 }],
        flagged: [],
        extras: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('the deterministic revision and the Markdown export', () => {
  it('renders the snapshot without a model, in order, with every source', async () => {
    const loaded = await loadTemplate();
    const input = cyberInput();
    const slots = deterministicSlots(input, loaded.template);
    expect(slots.rundown.map((e) => e.citations)).toEqual([[ids(2), ids(3)], [ids(5)]]);
    expect(slots.rundown[1]?.summary).toBe(
      'Brightwater Utility confirms a data breach of customer accounts',
    );
    expect(slots.extras).toBe(sectionOf(loaded.template, 'extras').marker);
    const markdown = renderMarkdown(slots, loaded.template);
    expect(markdown).toContain('## Rundown');
    expect(markdown).toContain('**Ransomware halts Harborline Port terminal operations**');
    expect(markdown).toContain(
      'Sources:\nhttps://news.example/harborline-ransomware\nhttps://wire.example/harborline',
    );
    expect(markdown).toContain('## Flagged, not published');
    expect(markdown).toContain('Carried to next week: Kestrelvale Water confirms a breach.');
    expect(markdown).toContain('<!-- extras:');
    // The validator accepts the deterministic rendering as a response too.
    expect(validateResponse(slots, input, loaded.template)).toEqual(slots);
  });
});

describe('validation of a model response against the selection', () => {
  it('rejects every departure from the selection with a fixed code and keeps nothing', async () => {
    const loaded = await loadTemplate();
    const input = cyberInput();
    const marker = sectionOf(loaded.template, 'extras').marker ?? '';
    const golden = goldenFor(input, marker) as {
      rundown: Record<string, unknown>[];
      flagged: unknown[];
      extras: string;
    };
    expect(validateResponse(golden, input, loaded.template).rundown).toHaveLength(2);
    const cases: [string, unknown][] = [
      ['response_invalid', { ...golden, extras: 42 }],
      ['response_entry_count', { ...golden, rundown: golden.rundown.slice(0, 1) }],
      ['response_order', { ...golden, rundown: [golden.rundown[1], golden.rundown[0]] }],
      [
        'response_citation_outside_selection',
        {
          ...golden,
          rundown: [{ ...golden.rundown[0], citations: [ids(2), ids(9)] }, golden.rundown[1]],
        },
      ],
      [
        'response_order',
        {
          ...golden,
          rundown: [{ ...golden.rundown[0], citations: [ids(3), ids(2)] }, golden.rundown[1]],
        },
      ],
      [
        'response_sources_differ',
        {
          ...golden,
          rundown: [
            { ...golden.rundown[0], sources: ['https://news.example/harborline-ransomware'] },
            golden.rundown[1],
          ],
        },
      ],
      [
        'response_sources_differ',
        {
          ...golden,
          rundown: [
            {
              ...golden.rundown[0],
              sources: ['https://evil.example/x', 'https://wire.example/harborline'],
            },
            golden.rundown[1],
          ],
        },
      ],
      ['response_flagged_differs', { ...golden, flagged: [] }],
      [
        'response_flagged_differs',
        {
          ...golden,
          flagged: [{ ...(golden.flagged[0] as object), disposition: 'carry' }, golden.flagged[1]],
        },
      ],
      ['response_extras_differs', { ...golden, extras: 'my own extras' }],
    ];
    for (const [code, raw] of cases) {
      expect(
        codeOf(() => validateResponse(raw, input, loaded.template)),
        code,
      ).toBe(code);
    }
  });
});

describe('generation through the transport seam', () => {
  it('produces both revisions with provenance for a cyberattack and a crypto selection', async () => {
    const loaded = await loadTemplate();
    const marker = sectionOf(loaded.template, 'extras').marker ?? '';
    for (const input of [cyberInput(), cryptoInput()]) {
      const requests: string[] = [];
      const transport = recordedTransport(
        { raw: goldenFor(input, marker), usage: { inputTokens: 1_200, outputTokens: 400 } },
        (request) => {
          requests.push(request.system);
          expect(request.model).toBe('claude-opus-5-5');
          expect(request.maxOutputTokens).toBe(16_000);
          expect(request.user).toContain(input.category);
          expect(request.user).not.toContain('note');
        },
      );
      const result = await generateRoundup(input, loaded, transport, {
        spentThisMonth: 0,
        expectedTemplateHash: loaded.hash,
      });
      expect(requests).toHaveLength(1);
      expect(result.generated.slots.rundown).toHaveLength(input.incidents.length);
      expect(result.generated.markdown).toContain('**Reformatted Headline 1**');
      expect(result.deterministic.slots.rundown[0]?.headline).toBe(
        input.incidents[0]?.rows[0]?.title,
      );
      expect(result.provenance).toMatchObject({
        model: 'claude-opus-5-5',
        promptVersion: PROMPT_VERSION,
        promptHash: promptHash(loaded.template),
        templateVersion: 'rundown-template@1',
        templateHash: loaded.hash,
        inputDigest: inputDigest(input),
        inputTokens: 1_200,
        outputTokens: 400,
        costMicrodollars: 1_200 * 4 + 400 * 20,
      });
    }
    expect(systemPrompt(loaded.template)).toContain('Never reorder');
    expect(systemPrompt(loaded.template)).toContain('US with no periods');
  });

  it('fails closed without a credential, refuses over the cap and on a template hash mismatch, and never keeps a bad response', async () => {
    const loaded = await loadTemplate();
    const input = cyberInput();
    const marker = sectionOf(loaded.template, 'extras').marker ?? '';
    let calls = 0;
    const counting = recordedTransport(
      { raw: goldenFor(input, marker), usage: { inputTokens: 1, outputTokens: 1 } },
      () => {
        calls += 1;
      },
    );
    expect(
      await codeOfAsync(() => generateRoundup(input, loaded, null, { spentThisMonth: 0 })),
    ).toBe('model_key_missing');
    expect(
      await codeOfAsync(() =>
        generateRoundup(input, loaded, counting, { spentThisMonth: MONTHLY_CAP_MICRODOLLARS }),
      ),
    ).toBe('spend_cap_exceeded');
    expect(
      await codeOfAsync(() =>
        generateRoundup(input, loaded, counting, {
          spentThisMonth: 0,
          expectedTemplateHash: 'f'.repeat(64),
        }),
      ),
    ).toBe('template_hash_mismatch');
    expect(calls).toBe(0);
    const bad = recordedTransport({
      raw: { ...(goldenFor(input, marker) as object), extras: 'changed' },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(
      await codeOfAsync(() => generateRoundup(input, loaded, bad, { spentThisMonth: 0 })),
    ).toBe('response_extras_differs');
    const failing = {
      generate: async () => {
        throw new Error('provider body that must not surface');
      },
    };
    let caught: unknown;
    try {
      await generateRoundup(input, loaded, failing, { spentThisMonth: 0 });
    } catch (error) {
      caught = error;
    }
    expect(isRoundupError(caught) && caught.code === 'model_failed').toBe(true);
    expect(String(caught)).not.toContain('provider body');
    const prepared = prepareGeneration(input, loaded);
    expect(prepared.worstCaseMicrodollars).toBe(
      worstCaseMicrodollars(prepared.system.length + prepared.user.length),
    );
  });
});

describe('cost', () => {
  it('prices at the published rates in microdollars and bounds the month', () => {
    expect(costMicrodollars({ inputTokens: 1_000_000, outputTokens: 0 })).toBe(4_000_000);
    expect(costMicrodollars({ inputTokens: 0, outputTokens: 1_000_000 })).toBe(20_000_000);
    expect(wouldExceedCap(24_000_000, 1_000_001)).toBe(true);
    expect(wouldExceedCap(0, worstCaseMicrodollars(40_000))).toBe(false);
    expect(monthKey(new Date('2026-10-22T23:59:59.000Z'))).toBe('2026-10');
    expect(monthKey(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11');
  });
});
