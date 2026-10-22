import type { RoundupInput } from './input.js';
import type { RoundupSlots } from './schema.js';
import { sectionOf, type RundownTemplate } from './template.js';

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
    flagged: input.flagged.map((entry) => ({
      headline: entry.headline,
      reason: entry.reason,
      disposition: entry.disposition,
    })),
    extras,
  };
}

/** Copy-ready Markdown in the template's entry format (D40). */
export function renderMarkdown(slots: RoundupSlots, template: RundownTemplate): string {
  const rundown = sectionOf(template, 'rundown');
  const extras = sectionOf(template, 'extras');
  const flagged = sectionOf(template, 'flagged');
  const label = template.entry.sources.label;
  const lines: string[] = [`## ${rundown.title}`, ''];
  for (const entry of slots.rundown) {
    lines.push(`**${entry.headline}**`, '', entry.summary, '', label, ...entry.sources, '');
  }
  lines.push(`## ${extras.title}`, '', slots.extras, '');
  if (slots.flagged.length > 0) {
    lines.push(`## ${flagged.title}`, '');
    for (const entry of slots.flagged) {
      lines.push(
        `- ${entry.disposition === 'carry' ? 'Carried to next week' : 'Omitted'}: ${entry.headline}. ${entry.reason}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
