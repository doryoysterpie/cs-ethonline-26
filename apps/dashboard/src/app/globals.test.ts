import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

/**
 * The stylesheet's rules (CAS-010, design note 1.2 and 1.6): every colour
 * literal sits inside `:root`, so a colour outside it is a token by name;
 * the overlay never takes a click or a focus; the blink stops under a
 * reduced-motion preference; the scanlines and the glow go under a
 * contrast preference; nothing is fetched (no `url(`, no `@import`).
 */
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch|hwb)\(/giu;

function blocks(css: string): { readonly selector: string; readonly body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const pattern = /([^{}]+)\{([^{}]*)\}/gu;
  for (const match of stripped.matchAll(pattern)) {
    out.push({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' });
  }
  return out;
}

describe('the stylesheet on the terminal grid', () => {
  it('names a colour literal only inside :root, and a token everywhere else', async () => {
    const css = await readFile(new URL('./globals.css', import.meta.url), 'utf8');
    const outside = blocks(css).filter(
      (block) => block.selector !== ':root' && COLOUR_LITERAL.test(block.body),
    );
    expect(outside.map((block) => block.selector)).toEqual([]);
    const root = blocks(css).find((block) => block.selector === ':root');
    expect(root).toBeDefined();
    // The nine brand tokens, as the identity defines them; nothing renamed.
    for (const token of [
      '--navy',
      '--panel',
      '--panel-raised',
      '--line',
      '--ink',
      '--muted',
      '--sky',
      '--orange',
      '--yellow',
      '--green',
      '--magenta',
    ]) {
      expect(root?.body).toContain(`${token}:`);
    }
    // Every token referenced outside :root is declared there.
    const referenced = new Set(
      [...css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/var\((--[a-z-]+)/gu)].map((m) => m[1]),
    );
    for (const token of referenced) expect(root?.body, token).toContain(`${token}:`);
  });

  it('keeps the overlay out of the way, stops the blink under reduced motion, drops the effects under more contrast, and fetches nothing', async () => {
    const css = await readFile(new URL('./globals.css', import.meta.url), 'utf8');
    const all = blocks(css);
    const overlay = all.find((block) => block.selector === 'body::after');
    expect(overlay?.body).toContain('pointer-events: none');
    expect(overlay?.body).toContain('position: fixed');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.cursor\s*\{\s*animation:\s*none;/u);
    const contrast = css.slice(css.indexOf('@media (prefers-contrast: more)'));
    expect(contrast).toMatch(/body::after\s*\{\s*display:\s*none;/u);
    expect(contrast).toMatch(/text-shadow:\s*none;/u);
    expect(css).not.toMatch(/url\(|@import|@font-face/u);
    // The typeface is the system stack, named once as a token.
    expect(css).toMatch(/--mono:\s*\n?\s*ui-monospace/u);
  });
});
