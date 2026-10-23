import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sha256 } from './canonical.js';
import { MAX_OUTPUT_TOKENS, MONTHLY_CAP_MICRODOLLARS, worstCaseMicrodollars } from './cost.js';
import { isArticleError } from './errors.js';
import { generateArticle, prepareArticle } from './generate.js';
import { assertArticleInput, inputDigest, type ArticleInput, type ArticleRow } from './input.js';
import { PROMPT_VERSION, promptHash, systemPrompt } from './prompt.js';
import { MAX_MARKDOWN_CHARACTERS, renderMarkdown } from './render.js';
import { ArticleSlotsSchema, slotsJsonSchema, type ArticleSlots } from './schema.js';
import { countWords, quotedSpans } from './text.js';
import { recordedTransport } from './transport.js';
import { validateArticle } from './validate.js';

/**
 * Synthetic throughout: invented organizations, invented pages. No test opens
 * a socket; the package has nothing that could.
 */

const WEEK = '1b4e28ba-2fa1-4d3b-9c3e-0a1b2c3d4e5f';
const ids = {
  i1: '2b4e28ba-2fa1-4d3b-9c3e-0a1b2c3d4e51',
  i2: '2b4e28ba-2fa1-4d3b-9c3e-0a1b2c3d4e52',
  r1: '3b4e28ba-2fa1-4d3b-9c3e-0a1b2c3d4e61',
  r2: '3b4e28ba-2fa1-4d3b-9c3e-0a1b2c3d4e62',
  r3: '3b4e28ba-2fa1-4d3b-9c3e-0a1b2c3d4e63',
  r4: '3b4e28ba-2fa1-4d3b-9c3e-0a1b2c3d4e64',
  i3: '2b4e28ba-2fa1-4d3b-9c3e-0a1b2c3d4e53',
  r5: '3b4e28ba-2fa1-4d3b-9c3e-0a1b2c3d4e65',
  r6: '3b4e28ba-2fa1-4d3b-9c3e-0a1b2c3d4e66',
  outside: '3b4e28ba-2fa1-4d3b-9c3e-0a1b2c3d4e99',
};

const PAGE_1 =
  'Northwind Traders said on Monday that a cyberattack disrupted its order systems. "We took systems offline as a precaution," the company said in a statement. The company did not say when service would resume.';
const PAGE_2 =
  'A group calling itself Example Crew claimed responsibility for the Northwind Traders outage on its leak site, a claim the company has not confirmed. Bloomberg News reported that about 400 stores were affected, citing people familiar with the matter.';
const PAGE_3 =
  'Regulators in Ontario said they were monitoring the Northwind Traders incident and had received a notification from the company.';

function row(
  id: string,
  publisher: string,
  text: string | null,
  overrides: Partial<ArticleRow['reading']> = {},
): ArticleRow {
  return {
    sourceRowId: id,
    title: `A story at ${publisher}`,
    summary: 'A recorded summary.',
    url: `https://${publisher}/story/${id.slice(-2)}`,
    publisher,
    postedAt: '2026-10-19T12:00:00.000Z',
    reading:
      text === null
        ? {
            status: 'not_read',
            code: 'robots_disallowed',
            text: null,
            digest: null,
            bytes: 0,
            ...overrides,
          }
        : {
            status: 'read',
            code: null,
            text,
            digest: sha256(text),
            bytes: text.length * 10,
            ...overrides,
          },
  };
}

function cyberInput(): ArticleInput {
  return {
    weekRunId: WEEK,
    category: 'cyberattack',
    windowStart: '2026-10-18T03:59:00.000Z',
    windowEnd: '2026-10-25T03:59:00.000Z',
    incidents: [
      {
        incidentId: ids.i1,
        rows: [
          row(ids.r1, 'news.example.org', PAGE_1),
          row(ids.r2, 'wire.example.net', PAGE_2),
          row(ids.r4, 'paywall.example.com', null),
        ],
      },
      { incidentId: ids.i2, rows: [row(ids.r3, 'regulator.example.ca', PAGE_3)] },
    ],
  };
}

function cryptoInput(): ArticleInput {
  const input = cyberInput();
  return { ...input, category: 'crypto' };
}

/** Sentences of a known word count, to reach the contract's bounds deterministically. */
function filler(sentences: number): string {
  return Array.from(
    { length: sentences },
    (_, i) => `The company reported detail number ${i + 1} of the incident.`,
  ).join(' ');
}

function golden(input: ArticleInput, overrides: Partial<ArticleSlots> = {}): ArticleSlots {
  const notRead = input.incidents.flatMap((i) =>
    i.rows.filter((r) => r.reading.status === 'not_read').map((r) => r.sourceRowId),
  );
  return {
    headline: 'Northwind Traders takes order systems offline after cyberattack',
    standfirst:
      'Northwind Traders said on Monday that a cyberattack disrupted its order systems and that it took them offline as a precaution, with no date yet for a return to service.',
    paragraphs: [
      {
        section: 'what_happened',
        text: `Northwind Traders said on Monday that a cyberattack disrupted its order systems. ${filler(8)}`,
        citations: [ids.r1],
      },
      {
        section: 'organization_statement',
        text: `"We took systems offline as a precaution," the company said in a statement. ${filler(8)}`,
        citations: [ids.r1],
      },
      {
        section: 'scale_impact',
        text: `Bloomberg News reported that about 400 stores were affected, citing people familiar with the matter. ${filler(8)}`,
        citations: [ids.r2],
      },
      {
        section: 'attribution',
        text: `A group calling itself Example Crew claimed responsibility on its leak site, a claim the company has not confirmed. ${filler(8)}`,
        citations: [ids.r2],
      },
      {
        section: 'not_confirmed',
        text: `The company did not say when service would resume. ${filler(8)}`,
        citations: [ids.r1],
      },
      {
        section: 'prior_context',
        text: `Regulators in Ontario said they were monitoring the incident. ${filler(8)}`,
        citations: [ids.r3],
      },
      {
        section: 'next_step',
        text: `Regulators had received a notification from the company and were monitoring the incident. ${filler(7)}`,
        citations: [ids.r3, ids.r1],
      },
    ],
    victimNaming: {
      named: true,
      basis: 'two_independent',
      organization: 'Northwind Traders',
      citations: [ids.r1, ids.r2],
    },
    notRead,
    ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    return isArticleError(error) ? error.code : 'other';
  }
}

function codeOfSync(fn: () => unknown): string {
  try {
    fn();
    return 'accepted';
  } catch (error) {
    return isArticleError(error) ? error.code : 'other';
  }
}

describe('the input', () => {
  it('accepts a reading of the selection, digests it with its texts, and refuses what the contract forbids', () => {
    const input = cyberInput();
    expect(codeOfSync(() => assertArticleInput(input))).toBe('accepted');
    expect(inputDigest(input)).toMatch(/^[0-9a-f]{64}$/u);
    expect(inputDigest(input)).not.toBe(inputDigest(cryptoInput()));
    const first = input.incidents[0] as ArticleInput['incidents'][number];
    const r1 = first.rows[0] as ArticleRow;
    expect(codeOfSync(() => assertArticleInput({ ...input, incidents: [] }))).toBe('input_empty');
    // Nothing read at all is nothing to write from.
    expect(
      codeOfSync(() =>
        assertArticleInput({
          ...input,
          incidents: [{ incidentId: ids.i1, rows: [row(ids.r1, 'a.example.org', null)] }],
        }),
      ),
    ).toBe('input_empty');
    // A text whose digest does not match is refused, so a stale reading cannot pass.
    expect(
      codeOfSync(() =>
        assertArticleInput({
          ...input,
          incidents: [
            {
              incidentId: ids.i1,
              rows: [{ ...r1, reading: { ...r1.reading, digest: sha256('other') } }],
            },
          ],
        }),
      ),
    ).toBe('input_invalid');
    // An unread row carrying text, a read row without a code when partly read, a repeated row: each refused.
    expect(
      codeOfSync(() =>
        assertArticleInput({
          ...input,
          incidents: [
            { incidentId: ids.i1, rows: [row(ids.r1, 'a.example.org', null, { text: 'x' })] },
          ],
        }),
      ),
    ).toBe('input_invalid');
    expect(
      codeOfSync(() =>
        assertArticleInput({
          ...input,
          incidents: [
            {
              incidentId: ids.i1,
              rows: [row(ids.r1, 'a.example.org', PAGE_1, { status: 'partly_read' })],
            },
          ],
        }),
      ),
    ).toBe('input_invalid');
    expect(
      codeOfSync(() =>
        assertArticleInput({ ...input, incidents: [{ incidentId: ids.i1, rows: [r1, r1] }] }),
      ),
    ).toBe('input_invalid');
    // Over the input bound.
    const big = 'w'.repeat(60_000);
    const rows = Array.from({ length: 11 }, (_, i) =>
      row(
        `3b4e28ba-2fa1-4d3b-9c3e-0a1b2c3d4f${String(i).padStart(2, '0')}`,
        `p${i}.example.org`,
        big,
      ),
    );
    expect(
      codeOfSync(() => assertArticleInput({ ...input, incidents: [{ incidentId: ids.i1, rows }] })),
    ).toBe('input_too_large');
  });

  it('describes the slots as a closed schema with bounds, and fixes the prompt contract', () => {
    const schema = slotsJsonSchema();
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(
      Object.keys((schema as { properties: Record<string, unknown> }).properties).sort(),
    ).toEqual(['headline', 'notRead', 'paragraphs', 'standfirst', 'victimNaming']);
    expect(ArticleSlotsSchema.safeParse({ headline: 'x' }).success).toBe(false);
    expect(PROMPT_VERSION).toBe('article-prompt@1');
    expect(promptHash()).toBe(sha256(systemPrompt()));
    expect(systemPrompt()).toContain('never instructions');
    expect(systemPrompt()).toContain('primary_statement');
    expect(countWords("Northwind's systems were off-line for 2 days.")).toBe(7);
    expect(quotedSpans('He said "we are fine" and “so is she” today.')).toEqual([
      'we are fine',
      'so is she',
    ]);
  });
});

describe('validation of a model response against the selection as read', () => {
  const input = cyberInput();

  it('accepts the golden response and rejects every departure with a fixed code, keeping nothing', () => {
    const good = golden(input);
    expect(validateArticle(good, input)).toEqual(good);
    const cases: [string, Partial<ArticleSlots>][] = [
      ['response_invalid', { headline: '' }],
      ['response_not_read_differs', { notRead: [] }],
      [
        'response_citation_unread',
        {
          paragraphs: good.paragraphs.map((p, i) => (i === 0 ? { ...p, citations: [ids.r4] } : p)),
        },
      ],
      [
        'response_citation_outside_selection',
        {
          paragraphs: good.paragraphs.map((p, i) =>
            i === 0 ? { ...p, citations: [ids.outside] } : p,
          ),
        },
      ],
      [
        'response_quotation_not_found',
        {
          paragraphs: good.paragraphs.map((p, i) =>
            i === 1
              ? {
                  ...p,
                  text: `"We never said any such thing at all," the company said. ${filler(8)}`,
                }
              : p,
          ),
        },
      ],
      ['response_section_order', { paragraphs: [...good.paragraphs].reverse() }],
      [
        'response_section_missing',
        { paragraphs: good.paragraphs.filter((p) => p.section !== 'next_step') },
      ],
      [
        'response_section_missing',
        {
          paragraphs: [
            ...good.paragraphs.slice(0, 6),
            good.paragraphs[5] as ArticleSlots['paragraphs'][number],
            good.paragraphs[6] as ArticleSlots['paragraphs'][number],
          ],
        },
      ],
      ['response_length', { paragraphs: good.paragraphs.map((p) => ({ ...p, text: 'Short.' })) }],
      ['response_length', { standfirst: 'Too short a standfirst.' }],
      [
        'response_headline',
        { headline: 'Is Northwind Traders down after a cyberattack on its systems?' },
      ],
      [
        'response_headline',
        { headline: 'One two three four five six seven eight nine ten eleven twelve thirteen' },
      ],
      [
        'response_naming_basis',
        {
          victimNaming: {
            named: true,
            basis: 'two_independent',
            organization: 'Northwind Traders',
            citations: [ids.r1],
          },
        },
      ],
      [
        'response_naming_basis',
        {
          victimNaming: {
            named: true,
            basis: 'none',
            organization: 'Northwind Traders',
            citations: [],
          },
        },
      ],
      [
        'response_naming_basis',
        {
          victimNaming: {
            named: false,
            basis: 'none',
            organization: 'Northwind Traders',
            citations: [],
          },
        },
      ],
      [
        'response_citation_unread',
        {
          victimNaming: {
            named: true,
            basis: 'primary_statement',
            organization: 'Northwind Traders',
            citations: [ids.r4],
          },
        },
      ],
    ];
    for (const [code, overrides] of cases) {
      let caught: unknown;
      try {
        validateArticle(golden(input, overrides), input);
      } catch (error) {
        caught = error;
      }
      expect(isArticleError(caught) && caught.code, code).toBe(code);
      expect(String(isArticleError(caught) ? caught.message : '')).not.toContain('Northwind');
    }
    // Two sources from one publisher are not two independent reports.
    const samePublisher: ArticleInput = {
      ...input,
      incidents: [
        {
          incidentId: ids.i1,
          rows: [
            row(ids.r1, 'one.example.org', PAGE_1),
            row(ids.r2, 'one.example.org', PAGE_2),
            row(ids.r3, 'one.example.org', PAGE_3),
          ],
        },
      ],
    };
    expect(codeOfSync(() => validateArticle(golden(samePublisher), samePublisher))).toBe(
      'response_naming_basis',
    );
    // A short quotation is not checked; a long one is matched across quote styles and whitespace.
    const styled = golden(input, {
      paragraphs: good.paragraphs.map((p, i) =>
        i === 1
          ? {
              ...p,
              text: `“We took   systems offline as a precaution,” it said, "fine". ${filler(8)}`,
            }
          : p,
      ),
    });
    expect(validateArticle(styled, input).paragraphs[1]?.text).toContain('precaution');
  });
});

describe('the export numbers every citation (train review F3)', () => {
  /** The selection widened by two read sources no paragraph cites. */
  function widened(): ArticleInput {
    const input = cyberInput();
    return {
      ...input,
      incidents: [
        ...input.incidents,
        {
          incidentId: ids.i3,
          rows: [
            row(ids.r5, 'statement.example.org', PAGE_1),
            row(ids.r6, 'second.example.net', PAGE_2),
          ],
        },
      ],
    };
  }
  /** Every `[n]` marker in the export and every numbered Sources line. */
  function markersAndSources(markdown: string): { markers: number[]; sources: number[] } {
    const markers = [...markdown.matchAll(/\[(\d+)\]/gu)].map((m) => Number(m[1]));
    const block = markdown.slice(markdown.indexOf('## Sources'));
    const sources = [...block.matchAll(/^(\d+)\. /gmu)].map((m) => Number(m[1]));
    return { markers, sources };
  }

  it('gives a source cited only by the naming sentence its Sources line, on a primary statement and on two independent reports', () => {
    const input = widened();
    const cases: ArticleSlots['victimNaming'][] = [
      {
        named: true,
        basis: 'primary_statement',
        organization: 'Northwind Traders',
        citations: [ids.r5],
      },
      {
        named: true,
        basis: 'two_independent',
        organization: 'Northwind Traders',
        citations: [ids.r5, ids.r6],
      },
    ];
    for (const victimNaming of cases) {
      const slots = validateArticle(golden(input, { victimNaming }), input);
      const markdown = renderMarkdown(slots, input);
      const { markers, sources } = markersAndSources(markdown);
      expect(sources).toEqual(sources.map((_, i) => i + 1));
      expect(markers.every((n) => sources.includes(n))).toBe(true);
      const naming = markdown.split('\n').find((line) => line.startsWith('_Named: ')) ?? '';
      const namingMarkers = [...naming.matchAll(/\[(\d+)\]/gu)].map((m) => Number(m[1]));
      expect(namingMarkers).toHaveLength(victimNaming.citations.length);
      for (const n of namingMarkers) {
        expect(markdown).toMatch(
          new RegExp(`^${n}\\. (statement\\.example\\.org|second\\.example\\.net): `, 'mu'),
        );
      }
      expect(markdown).toContain('statement.example.org');
    }
  });
});

describe('generation through the transport seam', () => {
  it('produces the revision with provenance for a cyberattack and a crypto selection', async () => {
    for (const input of [cyberInput(), cryptoInput()]) {
      const requests: string[] = [];
      const transport = recordedTransport(
        { raw: golden(input), usage: { inputTokens: 90_000, outputTokens: 4_000 } },
        (request) => {
          requests.push(request.user);
          expect(request.model).toBe('claude-opus-5-5');
          expect(request.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
          expect(request.system).toBe(systemPrompt());
          const sent = JSON.parse(request.user) as {
            incidents: { rows: { reading: { text: string | null } }[] }[];
          };
          expect(sent.incidents[0]?.rows[0]?.reading.text).toBe(PAGE_1);
          expect(request.user).toContain(input.category);
        },
      );
      const generation = await generateArticle(input, transport, { spentThisMonth: 0 });
      expect(requests).toHaveLength(1);
      expect(generation.provenance).toMatchObject({
        model: 'claude-opus-5-5',
        promptVersion: 'article-prompt@1',
        promptHash: promptHash(),
        inputDigest: inputDigest(input),
        inputTokens: 90_000,
        outputTokens: 4_000,
        costMicrodollars: 90_000 * 4 + 4_000 * 20,
        namingBasis: 'two_independent',
      });
      expect(generation.provenance.wordCount).toBeGreaterThanOrEqual(450);
      expect(generation.provenance.sources.map((s) => [s.status, s.code])).toEqual([
        ['read', null],
        ['read', null],
        ['not_read', 'robots_disallowed'],
        ['read', null],
      ]);
      expect(generation.provenance.sources.every((s) => !('text' in s))).toBe(true);
      expect(generation.markdown).toContain(
        '# Northwind Traders takes order systems offline after cyberattack',
      );
      expect(generation.markdown).toContain('## Sources');
      expect(generation.markdown).toContain('## Not read');
      expect(generation.markdown).toContain('paywall.example.com');
      expect(generation.markdown).toContain('[1]');
      expect(renderMarkdown(generation.slots, input)).toBe(generation.markdown);
    }
  });

  it('fails closed without a credential, refuses over the cap, and never keeps a bad response', async () => {
    const input = cyberInput();
    expect(await codeOf(generateArticle(input, null, { spentThisMonth: 0 }))).toBe(
      'model_key_missing',
    );
    let calls = 0;
    const counting = recordedTransport(
      { raw: golden(input), usage: { inputTokens: 1, outputTokens: 1 } },
      () => {
        calls += 1;
      },
    );
    const prepared = prepareArticle(input);
    expect(prepared.worstCaseMicrodollars).toBe(
      worstCaseMicrodollars(prepared.system.length + prepared.user.length),
    );
    expect(prepared.worstCaseMicrodollars).toBeLessThan(1_500_000);
    expect(
      await codeOf(
        generateArticle(input, counting, {
          spentThisMonth: MONTHLY_CAP_MICRODOLLARS - prepared.worstCaseMicrodollars + 1,
        }),
      ),
    ).toBe('spend_cap_exceeded');
    expect(calls).toBe(0);
    const bad = recordedTransport({
      raw: golden(input, { notRead: [] }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(await codeOf(generateArticle(input, bad, { spentThisMonth: 0 }))).toBe(
      'response_not_read_differs',
    );
    const refusing = {
      async generate() {
        throw Object.assign(new Error('provider body'), { code: 'model_refused' });
      },
    };
    let caught: unknown;
    try {
      await generateArticle(input, refusing, { spentThisMonth: 0 });
    } catch (error) {
      caught = error;
    }
    expect(isArticleError(caught) && caught.code).toBe('model_refused');
    expect(String(caught)).not.toContain('provider body');
    const failing = {
      async generate() {
        throw new Error('socket hang up');
      },
    };
    expect(await codeOf(generateArticle(input, failing, { spentThisMonth: 0 }))).toBe(
      'model_failed',
    );
  });

  it('carries the billed usage on every failure after a response and none before one, and refuses a rendering past the stored bound', async () => {
    const input = cyberInput();
    // A response the validator rejects was billed all the same: the failure
    // carries the model and the usage for the ledger.
    const bad = recordedTransport({
      raw: golden(input, { notRead: [] }),
      usage: { inputTokens: 2_000, outputTokens: 500 },
    });
    let rejected: unknown;
    try {
      await generateArticle(input, bad, { spentThisMonth: 0 });
    } catch (error) {
      rejected = error;
    }
    expect(isArticleError(rejected) && rejected.code).toBe('response_not_read_differs');
    expect(isArticleError(rejected) && rejected.billed).toEqual({
      model: 'claude-opus-5-5',
      inputTokens: 2_000,
      outputTokens: 500,
    });
    // A transport that answered before failing carries the billed usage by
    // shape, never by class; a shape that is not a usage is no usage.
    const billedRefusal = {
      async generate() {
        throw Object.assign(new Error('declined'), {
          code: 'model_refused',
          billed: { model: 'claude-opus-5-5', inputTokens: 321, outputTokens: 12 },
        });
      },
    };
    let refusal: unknown;
    try {
      await generateArticle(input, billedRefusal, { spentThisMonth: 0 });
    } catch (error) {
      refusal = error;
    }
    expect(isArticleError(refusal) && refusal.code).toBe('model_refused');
    expect(isArticleError(refusal) && refusal.billed).toEqual({
      model: 'claude-opus-5-5',
      inputTokens: 321,
      outputTokens: 12,
    });
    const malformed = {
      async generate() {
        throw Object.assign(new Error('socket hang up'), {
          billed: { model: 'claude-opus-5-5', inputTokens: -1, outputTokens: 0 },
        });
      },
    };
    let failed: unknown;
    try {
      await generateArticle(input, malformed, { spentThisMonth: 0 });
    } catch (error) {
      failed = error;
    }
    expect(isArticleError(failed) && [failed.code, failed.billed]).toEqual(['model_failed', null]);
    // Before any request there is nothing to bill.
    let keyMissing: unknown;
    try {
      await generateArticle(input, null, { spentThisMonth: 0 });
    } catch (error) {
      keyMissing = error;
    }
    expect(isArticleError(keyMissing) && [keyMissing.code, keyMissing.billed]).toEqual([
      'model_key_missing',
      null,
    ]);
    // Two hundred sources that could not be read, each at the URL bound, list
    // past the stored bound in the export: the response passes every check
    // on its content and is refused on its size, billed and carrying the usage.
    const longUrl = `https://long.example.org/${'a'.repeat(2_048 - 'https://long.example.org/'.length)}`;
    expect(longUrl).toHaveLength(2_048);
    const wide: ArticleInput = {
      ...input,
      incidents: [
        ...input.incidents,
        ...Array.from({ length: 4 }, () => ({
          incidentId: randomUUID(),
          rows: Array.from({ length: 50 }, () => ({
            ...row(randomUUID(), 'long.example.org', null),
            url: longUrl,
          })),
        })),
      ],
    };
    assertArticleInput(wide);
    expect(renderMarkdown(golden(wide), wide).length).toBeGreaterThan(MAX_MARKDOWN_CHARACTERS);
    const long = recordedTransport({
      raw: golden(wide),
      usage: { inputTokens: 110_000, outputTokens: 4_000 },
    });
    let tooLong: unknown;
    try {
      await generateArticle(wide, long, { spentThisMonth: 0 });
    } catch (error) {
      tooLong = error;
    }
    expect(isArticleError(tooLong) && tooLong.code).toBe('response_too_long');
    expect(isArticleError(tooLong) && tooLong.billed).toEqual({
      model: 'claude-opus-5-5',
      inputTokens: 110_000,
      outputTokens: 4_000,
    });
    expect(String(tooLong)).not.toContain('long.example.org');
  });

  it('opens no socket: the package names no network module', async () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const sources = (await readdir(here)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(sources.length).toBeGreaterThan(8);
    const forbidden =
      /from '(?:node:)?(?:net|http|https|tls|dgram|http2|dns)'|undici|@anthropic-ai\/sdk|\bfetch\s*\(/u;
    for (const name of sources) {
      const text = await readFile(new URL(name, import.meta.url), 'utf8');
      expect(forbidden.test(text), name).toBe(false);
    }
  });
});
