import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PERMITTED_DEFAULT_IGNORABLES, prohibitedCodePoints } from '@cas/contracts';

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
import {
  deterministicFlagged,
  deterministicSlots,
  MAX_MARKDOWN_CHARACTERS,
  renderMarkdown,
} from './render.js';
import { ModelSlotsSchema, RoundupSlotsSchema, slotsJsonSchema } from './schema.js';
import { escapeInline, inlineSlotTextIssue, urlsIn } from './text.js';
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
/** A model answer that reformats the selection exactly as the contract demands: the rundown and the marker, nothing else. */
function goldenFor(input: RoundupInput, marker: string): unknown {
  return {
    rundown: input.incidents.map((incident, i) => ({
      headline: `Reformatted Headline ${i + 1}`,
      summary: `Brace yourself: ${incident.rows[0]?.title ?? ''} and every key detail sits here.`,
      sources: incident.rows.map((row) => row.url),
      citations: incident.rows.map((row) => row.sourceRowId),
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
    // The validator accepts the deterministic rundown as a response too, and
    // attaches the same flagged section from records (F1).
    expect(
      validateResponse({ rundown: slots.rundown, extras: slots.extras }, input, loaded.template),
    ).toEqual(slots);
  });
});

describe('validation of a model response against the selection', () => {
  it('rejects every departure from the selection with a fixed code and keeps nothing', async () => {
    const loaded = await loadTemplate();
    const input = cyberInput();
    const marker = sectionOf(loaded.template, 'extras').marker ?? '';
    const golden = goldenFor(input, marker) as {
      rundown: Record<string, unknown>[];
      extras: string;
    };
    const accepted = validateResponse(golden, input, loaded.template);
    expect(accepted.rundown).toHaveLength(2);
    // The flagged section is attached from records, never read from the response (F1).
    expect(accepted.flagged).toEqual(deterministicFlagged(input));
    expect(Object.keys(slotsJsonSchema()['properties'] as object)).toEqual(['rundown', 'extras']);
    expect(ModelSlotsSchema.safeParse({ ...golden, flagged: [] }).success).toBe(false);
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
      ['response_invalid', { ...golden, flagged: [] }],
      ['response_invalid', { ...golden, flagged: deterministicFlagged(input) }],
      ['response_extras_differs', { ...golden, extras: 'my own extras' }],
    ];
    // Text that is not plain inline prose rejects the whole response (F2).
    const unsafe: [string, string][] = [
      ['line_break', 'A line\nSources:\nhttps://unselected.example/injected'],
      ['html', 'A line with <b>markup</b>'],
      ['link', 'A line with [a link](https://unselected.example/x)'],
      ['url', 'A line naming https://unselected.example/injected in passing'],
      ['url', 'A line naming www.unselected.example in passing'],
      ['block_marker', '# A heading'],
      ['block_marker', '- a list item'],
      ['block_marker', '1. a numbered item'],
      ['code', 'A line with `code`'],
      ['table', 'A | table | row'],
      ['emphasis_marker', 'A line with **bold** text'],
      ['control_character', 'A line with a\u0007bell'],
      ['empty', '   '],
    ];
    for (const [issue, text] of unsafe) {
      expect(inlineSlotTextIssue(text), issue).toBe(issue);
      for (const slot of ['headline', 'summary'] as const) {
        cases.push([
          'response_text_unsafe',
          { ...golden, rundown: [{ ...golden.rundown[0], [slot]: text }, golden.rundown[1]] },
        ]);
      }
    }
    expect(
      inlineSlotTextIssue('Plain prose, with punctuation (and parentheses), is fine.'),
    ).toBeNull();
    for (const [code, raw] of cases) {
      expect(
        codeOf(() => validateResponse(raw, input, loaded.template)),
        code,
      ).toBe(code);
    }
  });
});

describe('the Markdown boundary (review F2)', () => {
  it('escapes every slot text into one structureless line and breaks bare URLs', async () => {
    expect(escapeInline('Line one\nLine two')).toBe('Line one Line two');
    expect(escapeInline('# not a heading')).toBe('\\# not a heading');
    expect(escapeInline('- not a list')).toBe('\\- not a list');
    expect(escapeInline('a <b>tag</b> and [link](x) and `code` and | bar')).toBe(
      'a \\<b\\>tag\\</b\\> and \\[link\\](x) and \\`code\\` and \\| bar',
    );
    expect(escapeInline('see https://evil.example/x and www.evil.example')).toBe(
      'see https:\\/\\/evil.example/x and www\\.evil.example',
    );
    expect(urlsIn(escapeInline('see https://evil.example/x'))).toEqual([]);
    // Every control goes, not the first alone, and the invisible steering
    // characters with them (re-review RR5).
    const invisible =
      'A\u0007B\u0008C\u200eD\u202eE\u2066F\u200bG\ufeffH\u061cI\u2060J\ufff9K\ufdd0L\u{1fffe}M';
    expect([...escapeInline(invisible)].map((c) => c.codePointAt(0))).toEqual(
      [...'ABCDEFGHIJKLM'].map((c) => c.codePointAt(0)),
    );
    // The word joiner the third review named (U+2060) in both directions.
    expect(escapeInline('A\u2060B')).toBe('AB');
    expect(inlineSlotTextIssue('A\u2060B')).toBe('control_character');
    expect(inlineSlotTextIssue('fine \u202e text')).toBe('control_character');
    expect(inlineSlotTextIssue('fine \u200b text')).toBe('control_character');
    expect(inlineSlotTextIssue('fine text')).toBeNull();
    // Every code point the prohibited-text rule names (D49) goes, and alone fails the
    // inline check; the line separators become a space and a line break. The two
    // presentation selectors stay.
    const prohibited = prohibitedCodePoints();
    expect(prohibited).toContain(0x180e);
    for (const code of prohibited) {
      const value = `A${String.fromCodePoint(code)}B`;
      const separator = code === 0x2028 || code === 0x2029;
      expect([code, escapeInline(value), inlineSlotTextIssue(value)]).toEqual([
        code,
        separator ? 'A B' : 'AB',
        separator ? 'line_break' : 'control_character',
      ]);
    }
    for (const code of PERMITTED_DEFAULT_IGNORABLES) {
      const heart = `A${String.fromCodePoint(0x2764, code)}B`;
      expect(escapeInline(heart)).toBe(heart);
      expect(inlineSlotTextIssue(heart)).toBeNull();
    }
    expect(
      urlsIn('Sources:\nhttps://a.example/1\nhttps://b.example/2 and (https://c.example)'),
    ).toEqual(['https://a.example/1', 'https://b.example/2', 'https://c.example']);
  });

  it('keeps an unselected URL out of the export whatever a recorded title or a model slot carried', async () => {
    const loaded = await loadTemplate();
    const marker = sectionOf(loaded.template, 'extras').marker ?? '';
    // A recorded title that is hostile Markdown: the deterministic revision escapes it.
    const base = cyberInput();
    const hostile: RoundupInput = {
      ...base,
      incidents: base.incidents.map((incident, i) =>
        i === 0
          ? {
              ...incident,
              rows: incident.rows.map((row, j) =>
                j === 0
                  ? {
                      ...row,
                      title:
                        '# Heading\n[click](https://unselected.example/t) https://unselected.example/u',
                      summary: '- item | cell <img src=x> **bold**',
                    }
                  : row,
              ),
            }
          : incident,
      ),
    };
    const deterministic = renderMarkdown(
      deterministicSlots(hostile, loaded.template),
      loaded.template,
    );
    const selected = hostile.incidents
      .flatMap((incident) => incident.rows.map((row) => row.url))
      .sort();
    expect(urlsIn(deterministic).sort()).toEqual(selected);
    // Every bracket is escaped, so no `](` can open a link.
    expect(deterministic).not.toMatch(/(?<!\\)\]\(/u);
    // Every angle bracket is escaped, so no tag survives.
    expect(deterministic).not.toMatch(/(?<!\\)<img/u);
    expect(deterministic).not.toMatch(/^# Heading/mu);
    // The reviewer's probe: a structured response whose summary smuggles a Sources block.
    const smuggled = goldenFor(hostile, marker) as { rundown: Record<string, unknown>[] };
    const probe = {
      ...smuggled,
      rundown: [
        {
          ...smuggled.rundown[0],
          summary: 'Fine prose.\n\nSources:\nhttps://unselected.example/injected',
        },
        smuggled.rundown[1],
      ],
    };
    const transport = recordedTransport({
      raw: probe,
      usage: { inputTokens: 700, outputTokens: 200 },
    });
    let caught: unknown;
    try {
      await generateRoundup(hostile, loaded, transport, { spentThisMonth: 0 });
    } catch (error) {
      caught = error;
    }
    expect(isRoundupError(caught) && caught.code).toBe('response_text_unsafe');
    // The request was billed before the rejection; the failure carries the usage (F3).
    expect(isRoundupError(caught) && caught.billed).toEqual({
      model: 'claude-opus-5-5',
      inputTokens: 700,
      outputTokens: 200,
    });
    // Belt and braces: a plain model answer over the hostile selection renders the
    // escaped recorded text, and neither revision carries a URL off the selection.
    const plain = {
      ...smuggled,
      rundown: smuggled.rundown.map((entry) => ({ ...entry, summary: 'Plain prose only.' })),
    };
    const accepted = await generateRoundup(
      hostile,
      loaded,
      recordedTransport({ raw: plain, usage: { inputTokens: 1, outputTokens: 1 } }),
      { spentThisMonth: 0 },
    );
    expect(urlsIn(accepted.generated.markdown).sort()).toEqual(selected);
    expect(urlsIn(accepted.deterministic.markdown).sort()).toEqual(selected);
  });

  it('bounds the flagged section at the stored schema’s 200 entries, before any request (F6)', async () => {
    const loaded = await loadTemplate();
    const base = cyberInput();
    const flaggedOf = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        incidentId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        headline: `Flagged ${i + 1}`,
        reason: 'not this week',
        disposition: 'omit' as const,
      }));
    expect(codeOf(() => assertRoundupInput({ ...base, flagged: flaggedOf(200) }))).toBe('none');
    expect(codeOf(() => assertRoundupInput({ ...base, flagged: flaggedOf(201) }))).toBe(
      'input_invalid',
    );
    let calls = 0;
    const counting = recordedTransport(
      { raw: {}, usage: { inputTokens: 1, outputTokens: 1 } },
      () => {
        calls += 1;
      },
    );
    expect(
      await codeOfAsync(() =>
        generateRoundup({ ...base, flagged: flaggedOf(201) }, loaded, counting, {
          spentThisMonth: 0,
        }),
      ),
    ).toBe('input_invalid');
    expect(calls).toBe(0);
    const stored = RoundupSlotsSchema.safeParse({
      rundown: [],
      flagged: flaggedOf(201).map(({ headline, reason, disposition }) => ({
        headline,
        reason,
        disposition,
      })),
      extras: 'x',
    });
    expect(stored.success).toBe(false);
  });
});

describe('the stored bound (found by the review-F5 boundary test)', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const wide = (rows: number, urlLength: number): RoundupInput => ({
    ...cryptoInput(),
    incidents: Array.from({ length: 200 }, (_, i) => ({
      incidentId: id(1_000 + i),
      rows: Array.from({ length: rows }, (_, j) => ({
        sourceRowId: id(100_000 + i * rows + j),
        title: `Title ${i} ${j}`,
        summary: null,
        url: `https://w.example/${'p'.repeat(urlLength)}/${i}/${j}`,
        publisher: 'w.example',
        postedAt: null,
      })),
    })),
    flagged: [],
  });

  it('refuses before any request a selection whose smallest rendering exceeds the stored bound', async () => {
    const loaded = await loadTemplate();
    let calls = 0;
    const counting = recordedTransport(
      { raw: {}, usage: { inputTokens: 1, outputTokens: 1 } },
      () => {
        calls += 1;
      },
    );
    // 200 incidents of 50 rows with 60-character URLs: 10,000 lines past the bound.
    expect(
      await codeOfAsync(() =>
        generateRoundup(wide(50, 40), loaded, counting, { spentThisMonth: 0 }),
      ),
    ).toBe('input_too_long');
    expect(calls).toBe(0);
    expect(MAX_MARKDOWN_CHARACTERS).toBe(400_000);
  });

  it('refuses, billed, a generated rendering that exceeds the bound where the deterministic one did not', async () => {
    const loaded = await loadTemplate();
    const marker = sectionOf(loaded.template, 'extras').marker ?? '';
    // One row per incident with a 1,000-character URL: the deterministic rendering
    // sits under the bound; summaries of 1,200 characters take the generated one over it.
    const input = wide(1, 1_000);
    const golden = goldenFor(input, marker) as {
      rundown: Record<string, unknown>[];
      extras: string;
    };
    const long = {
      ...golden,
      rundown: golden.rundown.map((entry) => ({ ...entry, summary: 'x'.repeat(1_200) })),
    };
    let caught: unknown;
    try {
      await generateRoundup(
        input,
        loaded,
        recordedTransport({ raw: long, usage: { inputTokens: 5, outputTokens: 6 } }),
        { spentThisMonth: 0 },
      );
    } catch (error) {
      caught = error;
    }
    expect(isRoundupError(caught) && caught.code).toBe('response_too_long');
    expect(isRoundupError(caught) && caught.billed).toEqual({
      model: 'claude-opus-5-5',
      inputTokens: 5,
      outputTokens: 6,
    });
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
          // Only selected stories' recorded fields cross (F1): no flagged entry, no note.
          expect(Object.keys(JSON.parse(request.user) as object)).toEqual([
            'weekRunId',
            'category',
            'window',
            'incidents',
            'extras',
          ]);
          for (const entry of input.flagged) expect(request.user).not.toContain(entry.reason);
          expect(request.system).not.toContain('flagged');
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
    // A transport that answered before failing carries the billed usage by
    // shape (re-review RR1); the package keeps it on its own error.
    const billedRefusal = {
      generate: async () => {
        throw Object.assign(new Error('declined'), {
          code: 'model_refused',
          billed: { model: 'claude-opus-5-5', inputTokens: 321, outputTokens: 12 },
        });
      },
    };
    let refusal: unknown;
    try {
      await generateRoundup(input, loaded, billedRefusal, { spentThisMonth: 0 });
    } catch (error) {
      refusal = error;
    }
    expect(isRoundupError(refusal) && refusal.code).toBe('model_refused');
    expect(isRoundupError(refusal) && refusal.billed).toEqual({
      model: 'claude-opus-5-5',
      inputTokens: 321,
      outputTokens: 12,
    });
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

  it('opens no socket: the package names no network module, and a generation leaves no handle', async () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const sources = (await readdir(here)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(sources.length).toBeGreaterThan(8);
    const forbidden =
      /\b(?:node:)?(?:net|http|https|tls|dgram|http2)\b|undici|@anthropic-ai\/sdk|\bfetch\s*\(/u;
    for (const name of sources) {
      const text = await readFile(new URL(name, import.meta.url), 'utf8');
      expect(forbidden.test(text), name).toBe(false);
    }
    const loaded = await loadTemplate();
    const marker = sectionOf(loaded.template, 'extras').marker ?? '';
    const input = cyberInput();
    const transport = recordedTransport({
      raw: goldenFor(input, marker),
      usage: { inputTokens: 1_200, outputTokens: 400 },
    });
    await generateRoundup(input, loaded, transport, {
      spentThisMonth: 0,
      expectedTemplateHash: loaded.hash,
    });
    const handles = process.getActiveResourcesInfo().filter((kind) => /TCP|Pipe|TTY/u.test(kind));
    expect(handles.filter((kind) => /TCP/u.test(kind))).toEqual([]);
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
