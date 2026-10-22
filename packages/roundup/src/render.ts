import type { RoundupInput } from './input.js';
import type { RoundupFlagged, RoundupSlots } from './schema.js';
import { sectionOf, type RundownTemplate } from './template.js';
import { escapeInline } from './text.js';

/**
 * The most characters a stored revision holds: migration 0015's bound on
 * `roundup_revisions.markdown`, pinned here so a round-up that could not be
 * stored is refused before any request is made (found by the review-F5
 * boundary test: a selection at the row bound rendered past the bound).
 */
export const MAX_MARKDOWN_CHARACTERS = 400_000;

/** The flagged section, from records alone: the same in every revision, never from a model (review F1). */
export function deterministicFlagged(input: RoundupInput): RoundupFlagged[] {
  return input.flagged.map((entry) => ({
    headline: entry.headline,
    reason: entry.reason,
    disposition: entry.disposition,
  }));
}

/**
 * The deterministic revision 0: the same snapshot rendered without a model.
 * Headline from the representative row's recorded title, summary from the
 * recorded summary text (or the title when none), sources and citations in
 * row order. It is what the owner edits if the model is unavailable.
 */
export function deterministicSlots(input: RoundupInput, template: RundownTemplate): RoundupSlots {
  const extras = sectionOf(template, 'extras').marker ?? '';
  return {
    rundown: input.incidents.map((incident) => {
      const representative = incident.rows[0];
      if (representative === undefined) throw new Error('an incident without rows');
      const summary = (
        incident.rows.find((row) => row.summary !== null)?.summary ?? representative.title
      ).trim();
      return {
        headline: representative.title.trim(),
        summary: summary.length === 0 ? representative.title.trim() : summary,
        sources: incident.rows.map((row) => row.url),
        citations: incident.rows.map((row) => row.sourceRowId),
      };
    }),
    flagged: deterministicFlagged(input),
    extras,
  };
}

/**
 * Copy-ready Markdown in the template's entry format (D40). Every slot text,
 * model-written or recorded, passes through `escapeInline` (review F2): one
 * line, no structure, no link; the sources lines are the only URLs.
 */
export function renderMarkdown(slots: RoundupSlots, template: RundownTemplate): string {
  const rundown = sectionOf(template, 'rundown');
  const extras = sectionOf(template, 'extras');
  const flagged = sectionOf(template, 'flagged');
  const label = template.entry.sources.label;
  const lines: string[] = [`## ${rundown.title}`, ''];
  for (const entry of slots.rundown) {
    lines.push(
      `**${escapeInline(entry.headline)}**`,
      '',
      escapeInline(entry.summary),
      '',
      label,
      ...entry.sources,
      '',
    );
  }
  lines.push(`## ${extras.title}`, '', slots.extras, '');
  if (slots.flagged.length > 0) {
    lines.push(`## ${flagged.title}`, '');
    for (const entry of slots.flagged) {
      lines.push(
        `- ${entry.disposition === 'carry' ? 'Carried to next week' : 'Omitted'}: ${escapeInline(entry.headline)}. ${escapeInline(entry.reason)}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
