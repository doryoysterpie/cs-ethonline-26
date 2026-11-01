import { describe, expect, it } from 'vitest';

import { PERMITTED_DEFAULT_IGNORABLES, prohibitedCodePoints } from '@cas/contracts';
import { loadTemplate, renderMarkdown } from '@cas/roundup';

import {
  articleHeadline,
  articleSourceUrls,
  displayText,
  publishersOf,
  roundupHeadline,
  roundupStories,
} from './story.ts';

const A = ['https://news.example.org/story/1', 'https://wire.example.net/a?b=1'];
const B = ['https://regulator.example.ca/notice'];
const C = ['https://news.example.org/story/2', 'https://other.example.com/x'];

async function published(
  headlines: readonly string[],
): Promise<{ markdown: string; rundown: { sources: string[] }[] }> {
  const loaded = await loadTemplate();
  const rundown = [A, B, C].map((sources, i) => ({
    headline: headlines[i] ?? `Headline ${i}`,
    summary: `A summary that names https://inline.example/never-a-source and nothing else ${i}.`,
    sources,
    citations: sources.map((_, j) => `3b4e28ba-2fa1-4d3b-9c3e-0a1b2c3d4e${i}${j}`),
  }));
  const marker = loaded.template.sections.find((s) => s.id === 'extras')?.marker ?? 'extras';
  const markdown = renderMarkdown({ rundown, flagged: [], extras: marker }, loaded.template);
  return { markdown, rundown: rundown.map((e) => ({ sources: [...e.sources] })) };
}

describe('a story as the published text states it (CAS-009)', () => {
  it('reads each round-up entry’s published headline by its sources, escapes resolved, order of the URLs ignored', async () => {
    const { markdown, rundown } = await published([
      'Harborline Port halts *terminal* operations: see https://x.example',
      'Regulator notified',
      'Third story',
    ]);
    expect(markdown).toContain('\\*terminal\\*');
    expect(roundupHeadline(markdown, A)).toBe(
      'Harborline Port halts *terminal* operations: see https://x.example',
    );
    expect(roundupHeadline(markdown, [...A].reverse())).toBe(roundupHeadline(markdown, A));
    expect(roundupHeadline(markdown, B)).toBe('Regulator notified');
    // A URL named inside a summary is not a sources line; a partial or larger set is not the entry.
    expect(roundupHeadline(markdown, ['https://inline.example/never-a-source'])).toBeNull();
    expect(roundupHeadline(markdown, [A[0] as string])).toBeNull();
    expect(roundupHeadline(markdown, [...A, ...B])).toBeNull();
    expect(roundupHeadline(markdown, [])).toBeNull();
    expect(roundupStories(markdown, rundown).map((s) => s.entryIndex)).toEqual([0, 1, 2]);
  });

  it('follows the owner’s edit: a corrected headline is what shows, a removed entry is absent', async () => {
    const { markdown, rundown } = await published(['Original headline', 'Second', 'Third']);
    const corrected = markdown.replace('**Original headline**', '**Corrected headline**');
    expect(roundupHeadline(corrected, A)).toBe('Corrected headline');
    expect(corrected).not.toContain('Original headline');
    // The owner deletes the second entry's block from the markdown.
    const start = corrected.indexOf('**Second**');
    const end = corrected.indexOf('**Third**');
    const removed = corrected.slice(0, start) + corrected.slice(end);
    expect(roundupHeadline(removed, B)).toBeNull();
    expect(roundupStories(removed, rundown).map((s) => s.entryIndex)).toEqual([0, 2]);
    // An entry whose bold opening line was rewritten into prose is absent, never guessed.
    const prose = removed.replace('**Third**', 'Third, in prose');
    expect(roundupHeadline(prose, C)).toBeNull();
  });

  it('reads an article’s headline and the URLs of its Sources section only', () => {
    const markdown = [
      '# Northwind Traders takes order systems offline',
      '',
      '**A standfirst that is not a headline.**',
      '',
      'A paragraph that cites https://inline.example/x in passing. [1]',
      '',
      '## Sources',
      '',
      '1. news.example.org: https://news.example.org/story/1',
      '2. wire.example.net: https://wire.example.net/a',
      '',
      '_Named: Northwind Traders, on two independent reports ([1][2])._',
      '',
      '## Not read',
      '',
      '- paywall.example.com: https://paywall.example.com/z (robots_disallowed)',
      '',
    ].join('\n');
    expect(articleHeadline(markdown)).toBe('Northwind Traders takes order systems offline');
    expect(articleSourceUrls(markdown)).toEqual([
      'https://news.example.org/story/1',
      'https://wire.example.net/a',
    ]);
    expect(articleHeadline('No heading here.\n')).toBeNull();
    expect(articleSourceUrls('# Title\n\nNo sources.\n')).toEqual([]);
  });

  it('names publishers by host, once each, in order, and keeps display text to one bounded line', () => {
    expect(
      publishersOf([
        'https://News.Example.org/1',
        'https://news.example.org/2',
        'not a url',
        'https://wire.example.net/3',
      ]),
    ).toEqual(['news.example.org', 'wire.example.net']);
    expect(
      publishersOf(Array.from({ length: 20 }, (_, i) => `https://p${i}.example/x`)),
    ).toHaveLength(12);
    expect(displayText(`a ${String.fromCodePoint(0x202e)} b\n c`)).toBe('a b c');
    expect(displayText('   ')).toBeNull();
    const long = displayText('x'.repeat(400));
    expect(long).toHaveLength(300);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('removes every code point the prohibited-text rule names from a published headline, and keeps emoji presentation (D49)', () => {
    const char = (code: number): string => String.fromCodePoint(code);
    const prohibited = prohibitedCodePoints();
    expect(prohibited).toEqual(expect.arrayContaining([0x061c, 0x180e, 0x00ad, 0xe0001]));
    for (const code of prohibited) {
      const separator = code === 0x2028 || code === 0x2029;
      expect([code, displayText(`A${char(code)}B`)]).toEqual([code, separator ? 'A B' : 'AB']);
    }
    for (const code of PERMITTED_DEFAULT_IGNORABLES) {
      const heart = `A${char(0x2764)}${char(code)}B`;
      expect(displayText(heart)).toBe(heart);
    }
    // The gap the card filter's own list left (U+061C), through the published markdown.
    const markdown = `**Port${char(0x061c)} halts${char(0x180e)} terminal**\n\nhttps://news.example.org/1\n`;
    expect(roundupHeadline(markdown, ['https://news.example.org/1'])).toBe('Port halts terminal');
  });
});
