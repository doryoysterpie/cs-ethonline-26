import 'server-only';

import { fromMarkdown } from 'mdast-util-from-markdown';

/**
 * A story as the published text states it (CAS-009, D48). A card's headline
 * is read from the published markdown, never from the slots: an edited
 * revision copies the slots of the one before it and changes only the
 * markdown, so the slots can hold text the owner corrected away. The parser
 * is the one the sanitiser uses; backslash escapes are resolved by it.
 *
 * A round-up entry is a block that opens with a paragraph holding one bold
 * phrase (the headline) and whose sources lines, each a bare URL on its own
 * line, are exactly the entry's URLs. An article is its first first-level
 * heading, its sources the URLs of its "Sources" section. Anything the owner
 * removed or restructured past recognition is absent, and a card of it
 * answers not found rather than showing what the published text no longer
 * says.
 */

interface Walkable {
  readonly type: string;
  readonly value?: string;
  readonly children?: readonly Walkable[];
  readonly depth?: number;
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
}

export const HEADLINE_MAX = 300;
const PUBLISHERS_MAX = 12;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const URL_LINE = /^\s*(https?:\/\/\S+)\s*$/u;
const URL_AT_END = /(https?:\/\/\S+)\s*$/u;
// Controls, separators and bidirectional overrides: removed, never shown.
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;

/** The text a node carries, escapes resolved, markup dropped. */
function plainText(node: Walkable): string {
  if (typeof node.value === 'string' && (node.type === 'text' || node.type === 'inlineCode')) {
    return node.value;
  }
  if (node.type === 'break') return ' ';
  return (node.children ?? []).map(plainText).join('');
}

/** One line of display text, bounded; null when nothing is left. */
export function displayText(value: string, max: number = HEADLINE_MAX): string | null {
  const clean = value.replace(INVISIBLE, ' ').replace(/\s+/gu, ' ').trim();
  if (clean.length === 0) return null;
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function offsets(node: Walkable): { start: number; end: number } | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null;
}

/** A paragraph whose only content is one bold phrase: the opening line of a round-up entry. */
function boldLine(node: Walkable): Walkable | null {
  if (node.type !== 'paragraph') return null;
  const parts = (node.children ?? []).filter(
    (child) => !(child.type === 'text' && (child.value ?? '').trim() === ''),
  );
  const only = parts[0];
  return parts.length === 1 && only !== undefined && only.type === 'strong' ? only : null;
}

interface EntryBlock {
  readonly headline: string | null;
  readonly urls: readonly string[];
}

function roundupBlocks(markdown: string): EntryBlock[] {
  const root = fromMarkdown(markdown) as unknown as { children: readonly Walkable[] };
  const blocks: EntryBlock[] = [];
  let current: { headline: string | null; start: number; end: number } | null = null;
  const close = (): void => {
    if (current === null) return;
    const urls = markdown
      .slice(current.start, current.end)
      .split('\n')
      .map((line) => URL_LINE.exec(line)?.[1])
      .filter((url): url is string => url !== undefined);
    blocks.push({ headline: current.headline, urls });
    current = null;
  };
  for (const node of root.children) {
    const at = offsets(node);
    const bold = boldLine(node);
    if (bold !== null && at !== null) {
      close();
      current = { headline: displayText(plainText(bold)), start: at.start, end: at.end };
      continue;
    }
    if (node.type === 'heading') {
      close();
      continue;
    }
    if (current !== null && at !== null) current.end = at.end;
  }
  close();
  return blocks;
}

function sameUrls(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((url, i) => url === right[i]);
}

/** The published headline of the round-up entry whose sources are these, or null when the text no longer holds it. */
export function roundupHeadline(markdown: string, sources: readonly string[]): string | null {
  if (sources.length === 0) return null;
  const block = roundupBlocks(markdown).find((candidate) => sameUrls(candidate.urls, sources));
  return block?.headline ?? null;
}

/** Every entry of the slots the published text still holds, with its published headline. */
export function roundupStories(
  markdown: string,
  rundown: readonly { readonly sources: readonly string[] }[],
): { readonly entryIndex: number; readonly headline: string }[] {
  const blocks = roundupBlocks(markdown);
  const stories: { entryIndex: number; headline: string }[] = [];
  rundown.forEach((entry, entryIndex) => {
    const block = blocks.find((candidate) => sameUrls(candidate.urls, entry.sources));
    if (block?.headline !== null && block?.headline !== undefined) {
      stories.push({ entryIndex, headline: block.headline });
    }
  });
  return stories;
}

/** The article's published headline: its first first-level heading, or null. */
export function articleHeadline(markdown: string): string | null {
  const root = fromMarkdown(markdown) as unknown as { children: readonly Walkable[] };
  const heading = root.children.find((node) => node.type === 'heading' && node.depth === 1);
  return heading === undefined ? null : displayText(plainText(heading));
}

/** The URLs of the article's "Sources" section, in order. */
export function articleSourceUrls(markdown: string): string[] {
  const root = fromMarkdown(markdown) as unknown as { children: readonly Walkable[] };
  const index = root.children.findIndex(
    (node) => node.type === 'heading' && plainText(node).trim().toLowerCase() === 'sources',
  );
  if (index < 0) return [];
  const heading = root.children[index];
  const start = heading === undefined ? null : offsets(heading)?.end;
  if (start === null || start === undefined) return [];
  const next = root.children.slice(index + 1).find((node) => node.type === 'heading');
  const end = next === undefined ? markdown.length : (offsets(next)?.start ?? markdown.length);
  return markdown
    .slice(start, end)
    .split('\n')
    .map((line) => URL_AT_END.exec(line)?.[1])
    .filter((url): url is string => url !== undefined);
}

/** The publishers' names: each URL's host name, once each, in order; the card's attribution. */
export function publishersOf(urls: readonly string[]): string[] {
  const hosts: string[] = [];
  for (const url of urls) {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (HOST.test(host) && !hosts.includes(host)) hosts.push(host);
    if (hosts.length === PUBLISHERS_MAX) break;
  }
  return hosts;
}
