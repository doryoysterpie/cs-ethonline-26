import { describe, expect, it } from 'vitest';

import type { PublicStoryCard } from '@cas/contracts';

import { rasterize } from './raster.ts';
import { cardSvg, escapeXml, wrap } from './svg.ts';

const card: PublicStoryCard = {
  id: 'AbCdEfGhIjKlMnOpQrSt_-',
  output: 'roundup',
  category: 'cyberattack',
  weekStart: '2026-10-18T03:59:00.000Z',
  weekEnd: '2026-10-25T03:59:00.000Z',
  revision: 2,
  headline: `<script>alert('x')</script> & "quoted" headline that runs long enough to wrap over several lines of the card`,
  publishers: ['news.example.org', 'wire.example.net'],
};

describe('the card image (CAS-009, D48)', () => {
  it('escapes every string and names nothing outside the document', () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;',
    );
    const svg = cardSvg(card);
    expect(svg).not.toContain('<script');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).not.toMatch(/href|url\(|<image|<style|<foreignObject|xlink/u);
    expect(svg).toContain('news.example.org · wire.example.net');
    expect(svg).toContain('width="1200" height="630"');
  });

  it('wraps by words within the width, cuts a word longer than a line, and ends a long text with an ellipsis', () => {
    expect(wrap('aaa bbb ccc', 7, 3)).toEqual(['aaa bbb', 'ccc']);
    expect(wrap('x'.repeat(10), 4, 5)).toEqual(['xxxx', 'xxxx', 'xx']);
    const kept = wrap('one two three four five six', 7, 2);
    expect(kept).toHaveLength(2);
    expect(kept[1]?.endsWith('…')).toBe(true);
    expect(kept.every((line) => line.length <= 7)).toBe(true);
  });

  it('rasterizes the card to a 1,200 by 630 PNG in process, with its digest', async () => {
    const { png, sha256 } = await rasterize(cardSvg(card));
    expect(Buffer.from(png.subarray(0, 8)).toString('hex')).toBe('89504e470d0a1a0a');
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630]);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/u);
    // Twice in a process: the module is initialised once and reused.
    const again = await rasterize(cardSvg({ ...card, revision: 3 }));
    expect(again.sha256).not.toBe(sha256);
  }, 30_000);
});
