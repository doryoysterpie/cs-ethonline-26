import { Parser } from 'htmlparser2';

/**
 * Derived plain text from HTML source fields, produced with a maintained
 * tolerant HTML parser (htmlparser2). Nothing is executed or resolved: the
 * content of script, style and similar elements is dropped, entities are
 * decoded to characters, block elements become line breaks, whitespace runs
 * collapse, and the result is Unicode NFC. The raw field is kept unchanged by
 * the caller; this transformation is labelled and versioned so a later change
 * to the rules is visible on every row it produced. Output is never truncated.
 */

export const TEXT_TRANSFORM = 'html-to-text@1';

const SKIPPED = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'svg',
  'math',
  'head',
  'iframe',
  'object',
  'embed',
]);

const BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

const INLINE_WHITESPACE = /[ \t\f\v\u00a0]+/g;

export function htmlToText(html: string): string | null {
  const parts: string[] = [];
  let skipDepth = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        if (SKIPPED.has(name)) skipDepth += 1;
        else if (BLOCK.has(name)) parts.push('\n');
      },
      ontext(text) {
        if (skipDepth === 0) parts.push(text);
      },
      onclosetag(name) {
        if (SKIPPED.has(name)) skipDepth = Math.max(0, skipDepth - 1);
        else if (BLOCK.has(name)) parts.push('\n');
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  const lines = parts
    .join('')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(INLINE_WHITESPACE, ' ').trim())
    .filter((line) => line.length > 0);
  const text = lines.join('\n').normalize('NFC');
  return text.length === 0 ? null : text;
}
