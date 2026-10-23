import type { ArticleInput, ArticleRow } from './input.js';
import type { ArticleSlots } from './schema.js';

/**
 * The most characters a stored revision may hold: migration 0016's CHECK on
 * `article_revisions.markdown`, pinned here so a generated rendering past it
 * is refused with a fixed code (billed, recorded) instead of by the database.
 */
export const MAX_MARKDOWN_CHARACTERS = 400_000;

/**
 * The copy-ready Markdown the owner pastes out by hand: the headline, the
 * standfirst in bold, the paragraphs with their source numbers, a numbered
 * source list, and the sources that were not read, so the owner sees what
 * the article does not rest on. Markdown only; the dashboard renders it
 * through its sanitiser, never as HTML.
 */
export function renderMarkdown(slots: ArticleSlots, input: ArticleInput): string {
  const rows = new Map<string, ArticleRow>();
  for (const incident of input.incidents)
    for (const row of incident.rows) rows.set(row.sourceRowId, row);
  const numbers = new Map<string, number>();
  const number = (id: string): number => {
    let n = numbers.get(id);
    if (n === undefined) {
      n = numbers.size + 1;
      numbers.set(id, n);
    }
    return n;
  };
  const paragraphs = slots.paragraphs.map((paragraph) => {
    const marks = [...new Set(paragraph.citations)].map((id) => `[${number(id)}]`).join('');
    return `${paragraph.text} ${marks}`.trim();
  });
  const sources = [...numbers.entries()].map(([id, n]) => {
    const row = rows.get(id);
    return row === undefined ? `${n}. (unknown source)` : `${n}. ${row.publisher}: ${row.url}`;
  });
  const notRead = slots.notRead.map((id) => {
    const row = rows.get(id);
    return row === undefined
      ? `- (unknown source)`
      : `- ${row.publisher}: ${row.url} (${row.reading.code ?? 'not read'})`;
  });
  const naming =
    slots.victimNaming.named && slots.victimNaming.organization !== null
      ? `Named: ${slots.victimNaming.organization}, on ${slots.victimNaming.basis === 'primary_statement' ? 'a primary statement' : 'two independent reports'} (${slots.victimNaming.citations.map((id) => `[${number(id)}]`).join('')}).`
      : 'The organization is not named: no primary statement and fewer than two independent reports among the sources read.';
  return [
    `# ${slots.headline}`,
    '',
    `**${slots.standfirst}**`,
    '',
    ...paragraphs.flatMap((p) => [p, '']),
    '## Sources',
    '',
    ...sources,
    '',
    `_${naming}_`,
    ...(notRead.length === 0 ? [] : ['', '## Not read', '', ...notRead]),
    '',
  ].join('\n');
}
