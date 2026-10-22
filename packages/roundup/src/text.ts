/**
 * Slot text at the Markdown boundary (review of pull request 24, F2). A
 * model-controlled headline or summary is an inline run of prose and nothing
 * else: `assertInlineSlotText` names the first way a value departs from that
 * (a line break, a control character, raw HTML, a link or a bare URL, a
 * Markdown block marker, code, a table bar, emphasis markers), so the
 * validator can reject the whole response with a fixed code. `escapeInline`
 * is the one path every slot takes into the export, model-written or
 * recorded: whitespace collapsed to one line, control characters removed,
 * the characters that could open Markdown structure escaped, and a bare URL
 * scheme broken so no renderer links it. `urlsIn` lists what a renderer
 * would still see as a URL, for the check that nothing outside the selection
 * reaches the export.
 */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const LINE_BREAK = /[\r\n\u2028\u2029]/u;
const BLOCK_START = /^\s*(?:[#>+\-*=~|`]|\d{1,9}[.)])/u;
const URL_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/iu;

export type InlineTextIssue =
  | 'line_break'
  | 'control_character'
  | 'html'
  | 'link'
  | 'url'
  | 'block_marker'
  | 'code'
  | 'table'
  | 'emphasis_marker'
  | 'empty';

/** The first issue with a model-written slot, or null when it is plain inline prose. */
export function inlineSlotTextIssue(value: string): InlineTextIssue | null {
  if (value.trim().length === 0) return 'empty';
  if (LINE_BREAK.test(value)) return 'line_break';
  if (CONTROL.test(value)) return 'control_character';
  if (value.includes('<') || value.includes('>')) return 'html';
  if (value.includes('[') || value.includes(']') || value.includes('](')) return 'link';
  if (URL_LIKE.test(value)) return 'url';
  if (BLOCK_START.test(value)) return 'block_marker';
  if (value.includes('`')) return 'code';
  if (value.includes('|')) return 'table';
  if (value.includes('**') || value.includes('__')) return 'emphasis_marker';
  return null;
}

/** One line of text that no Markdown renderer turns into structure or a link. */
export function escapeInline(value: string): string {
  const oneLine = value
    .replace(/[\r\n\u2028\u2029]+/gu, ' ')
    .replace(CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const escaped = oneLine
    .replace(/[\\`*_[\]<>|#]/gu, (char) => `\\${char}`)
    .replace(/:\/\//gu, ':\\/\\/')
    .replace(/\bwww\./giu, (match) => `${match.slice(0, 3)}\\.`);
  return BLOCK_START.test(escaped) ? `\\${escaped.trimStart()}` : escaped;
}

const URL_IN_MARKDOWN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>)\]]+/giu;

/** Every URL a renderer would see in the Markdown, in order of appearance. */
export function urlsIn(markdown: string): string[] {
  return markdown.match(URL_IN_MARKDOWN) ?? [];
}
