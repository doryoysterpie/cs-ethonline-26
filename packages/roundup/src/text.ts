import { readFileSync } from 'node:fs';

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

/**
 * What the export removes from every slot text, model-written or recorded:
 * every code point the repository's prohibited-text policy names
 * (`data/policy/prohibited-text.json`, the one table the hygiene check over
 * tracked files and this export both read, so the two cannot drift): the C0
 * and C1 controls (tab, line feed and carriage return excepted, since line
 * breaks are collapsed on their own), the bidirectional controls, the
 * zero-width characters, the interlinear annotation characters and the
 * noncharacters; the line separators are left to the line-break collapse.
 * Stored text keeps them exactly (threat model RR13); the copy-ready
 * Markdown is a rendering, and removal is its escape. Global, so every
 * occurrence goes (re-review of 22 October 2026, RR5; the third review added
 * U+2060 and made the table the policy's).
 */
const POLICY_PATH = new URL('../../../data/policy/prohibited-text.json', import.meta.url);

function prohibitedRanges(): readonly (readonly [number, number])[] {
  const parsed = JSON.parse(readFileSync(POLICY_PATH, 'utf8')) as {
    readonly version: string;
    readonly rules: readonly {
      readonly rule: string;
      readonly ranges: readonly (readonly [string, string])[];
    }[];
  };
  if (parsed.version !== 'prohibited-text@1') throw new Error('prohibited-text policy version');
  return parsed.rules
    .filter((entry) => entry.rule !== 'line_separator')
    .flatMap((entry) =>
      entry.ranges.map(([from, to]): readonly [number, number] => [
        Number.parseInt(from, 16),
        Number.parseInt(to, 16),
      ]),
    );
}

const PROHIBITED_RANGES = prohibitedRanges();

/** Every code point the export removes, for the test that holds this table equal to the policy's. */
export function prohibitedCodePoints(): readonly number[] {
  const out: number[] = [];
  for (const [from, to] of PROHIBITED_RANGES)
    for (let code = from; code <= to; code += 1) out.push(code);
  return out;
}

const CONTROL = new RegExp(
  `[${PROHIBITED_RANGES.map(([from, to]) =>
    from === to ? `\\u{${from.toString(16)}}` : `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`,
  ).join('')}]`,
  'gu',
);
const LINE_BREAK = /[\r\n\u2028\u2029]/u;
const BLOCK_START = /^\s*(?:[#>+\-*=~|`]|\d{1,9}[.)])/u;
const WWW = /\bwww\./iu;

function hasControl(value: string): boolean {
  CONTROL.lastIndex = 0;
  return CONTROL.test(value);
}

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
  if (hasControl(value)) return 'control_character';
  if (value.includes('<') || value.includes('>')) return 'html';
  if (value.includes('[') || value.includes(']') || value.includes('](')) return 'link';
  if (value.includes('://') || WWW.test(value)) return 'url';
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

const SCHEME_CHAR = /[a-z0-9+.-]/iu;
const SCHEME = /^[a-z][a-z0-9+.-]*$/iu;
const URL_STOP = /[\s<>)\]]/u;

/**
 * Every URL a renderer would see in the Markdown, in order of appearance:
 * each `://`, the scheme read back from it and the body read forward to the
 * first stop character. One pass over the text, so a hostile string cannot
 * make this scan slow (code scanning, polynomial regular expression).
 */
export function urlsIn(markdown: string): string[] {
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const at = markdown.indexOf('://', from);
    if (at < 0) break;
    let start = at;
    while (start > 0 && SCHEME_CHAR.test(markdown[start - 1] ?? '')) start -= 1;
    let end = at + 3;
    while (end < markdown.length && !URL_STOP.test(markdown[end] ?? '')) end += 1;
    if (SCHEME.test(markdown.slice(start, at)) && end > at + 3)
      found.push(markdown.slice(start, end));
    from = at + 3;
  }
  return found;
}
