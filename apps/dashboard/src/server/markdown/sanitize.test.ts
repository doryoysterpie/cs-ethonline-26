import { describe, expect, it } from 'vitest';
import type { Element, Nodes } from 'hast';

import { ALLOWED_TAGS, textOf, toSafeHast } from './sanitize.ts';

function elements(node: Nodes, out: Element[] = []): Element[] {
  if (node.type === 'element') out.push(node);
  if ('children' in node) for (const child of node.children) elements(child, out);
  return out;
}

const HOSTILE = [
  '# Heading',
  '',
  'Text with <script>alert(1)</script> inline and <img src=x onerror=alert(2)> and <svg onload=alert(3)></svg>.',
  '',
  '<iframe src="https://evil.example"></iframe>',
  '',
  '[javascript link](javascript:alert(4))',
  '',
  '[data link](data:text/html;base64,PHNjcmlwdD5hbGVydCg1KTwvc2NyaXB0Pg==)',
  '',
  '[vbscript link](vbscript:msgbox)',
  '',
  '[fine link](https://example.org/path?q=1)',
  '',
  '![image](https://example.org/tracker.png)',
  '',
  '<a href="https://example.org" onclick="alert(6)">clicky</a>',
  '',
  `bidi ${String.fromCodePoint(0x202e)}gnirts and ${String.fromCodePoint(0)}nul`,
  '',
  '- item <b onmouseover=alert(7)>bold</b>',
  '',
  '```',
  '<script>code block is text</script>',
  '```',
].join('\n');

describe('markdown sanitizer', () => {
  it('produces only allowlisted elements and no executable content', () => {
    const tree = toSafeHast(HOSTILE);
    const tags = new Set(elements(tree).map((element) => element.tagName));
    for (const tag of tags) expect(ALLOWED_TAGS as readonly string[]).toContain(tag);
    expect(tags.has('script')).toBe(false);
    expect(tags.has('img')).toBe(false);
    expect(tags.has('svg')).toBe(false);
    expect(tags.has('iframe')).toBe(false);
    for (const element of elements(tree)) {
      for (const name of Object.keys(element.properties)) {
        expect(name.toLowerCase().startsWith('on'), `${element.tagName} ${name}`).toBe(false);
        expect(name).not.toBe('style');
        expect(name).not.toBe('src');
      }
    }
  });

  it('keeps only http and https links and hardens them', () => {
    const tree = toSafeHast(HOSTILE);
    const anchors = elements(tree).filter((element) => element.tagName === 'a');
    // A link with a refused protocol keeps its text and loses its href: an inert
    // element, not a navigation.
    const hrefs = anchors
      .map((anchor) => anchor.properties.href)
      .filter((href) => href !== undefined);
    expect(hrefs).toEqual(['https://example.org/path?q=1']);
    for (const anchor of anchors) {
      expect(anchor.properties.rel).toEqual(['noopener', 'noreferrer', 'nofollow']);
      expect(anchor.properties.target).toBeUndefined();
      expect(anchor.properties.onclick).toBeUndefined();
    }
    // The link texts survive as text even when the link is stripped.
    const text = textOf(tree);
    expect(text).toContain('javascript link');
    expect(text).toContain('data link');
  });

  it('keeps raw HTML and the contents of a code block as text, never as markup', () => {
    const tree = toSafeHast(HOSTILE);
    const text = textOf(tree);
    // The inline script text is dropped entirely by the sanitizer, but the
    // code block's script text is ordinary text inside `pre > code`.
    expect(text).toContain('<script>code block is text</script>');
    const code = elements(tree).filter((element) => element.tagName === 'code');
    expect(code.length).toBeGreaterThan(0);
    expect(text).not.toContain('alert(6)');
    expect(text).not.toContain('onerror');
  });

  it('never throws on hostile input and returns an empty tree for empty input', () => {
    expect(() => toSafeHast('')).not.toThrow();
    expect(() => toSafeHast('${String.fromCodePoint(0)}'.repeat(10))).not.toThrow();
    expect(() => toSafeHast('['.repeat(5000))).not.toThrow();
    expect(elements(toSafeHast(''))).toEqual([]);
  });
});
