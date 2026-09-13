import { sanitize, type Schema } from 'hast-util-sanitize';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toHast } from 'mdast-util-to-hast';
import type { Element, Nodes, Root } from 'hast';

/**
 * Markdown to a sanitized HTML syntax tree.
 *
 * The draft is stored as Markdown and, once edited by a person, is hostile
 * text like every other stored string. It is parsed to an AST and sanitized
 * against an allowlist: a small set of block and inline elements, the `href`
 * attribute on links and nothing else, `http` and `https` as the only link
 * protocols. Raw HTML inside the Markdown never reaches the tree, because the
 * parser is run without any HTML extension and the sanitizer strips the
 * `raw` nodes it would otherwise produce. Images are not allowed at all: the
 * dashboard proxies no remote image and loads none.
 *
 * The tree is rendered to React elements by `hast-util-to-jsx-runtime`, so
 * no HTML string is ever set into the document.
 *
 * Pure: no environment, no network.
 */

export const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'blockquote',
  'code',
  'pre',
  'hr',
  'a',
] as const;

export const ALLOWED_PROTOCOLS = ['http', 'https'] as const;

export const SCHEMA: Schema = {
  tagNames: [...ALLOWED_TAGS],
  attributes: {
    a: ['href'],
    ol: ['start'],
    '*': [],
  },
  protocols: { href: [...ALLOWED_PROTOCOLS] },
  strip: ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'img'],
  clobber: [],
  clobberPrefix: 'user-content-',
  allowComments: false,
  allowDoctypes: false,
  ancestors: { li: ['ol', 'ul'] },
};

/** Adds the link relation every anchor carries, after sanitization. */
function hardenLinks(node: Nodes): void {
  if (node.type === 'element') {
    const element = node as Element;
    if (element.tagName === 'a') {
      element.properties = {
        ...element.properties,
        rel: ['noopener', 'noreferrer', 'nofollow'],
      };
    }
  }
  if ('children' in node) for (const child of node.children) hardenLinks(child);
}

/** Parses and sanitizes Markdown. Never throws on hostile input. */
export function toSafeHast(markdown: string): Root {
  const mdast = fromMarkdown(markdown);
  const hast = toHast(mdast, { allowDangerousHtml: false });
  const safe = sanitize(hast, SCHEMA);
  hardenLinks(safe);
  return safe as Root;
}

/** The visible text of a tree, for tests and plain previews. */
export function textOf(node: Nodes): string {
  if (node.type === 'text') return node.value;
  if ('children' in node) return node.children.map(textOf).join('');
  return '';
}
