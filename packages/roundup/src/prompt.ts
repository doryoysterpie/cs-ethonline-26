import { sha256 } from './canonical.js';
import type { RoundupInput } from './input.js';
import type { RundownTemplate } from './template.js';

/**
 * The prompt contract (report, section 1.7): versioned, hashed, reformatting
 * only. The system prompt is built from the template's own rules, so the
 * template hash and the prompt hash together name exactly what the model
 * was told.
 */
export const PROMPT_VERSION = 'roundup-prompt@2';

export function systemPrompt(template: RundownTemplate): string {
  const summaryRules = template.entry.summary.rules.map((rule) => `- ${rule}`).join('\n');
  return [
    `You reformat recorded news fields into a weekly round-up. Contract ${PROMPT_VERSION}, template ${template.version}.`,
    'You receive a JSON selection: incidents in editorial order, each with member rows (title, summary, url, publisher, postedAt).',
    'Return only JSON matching the required schema. Rules:',
    `- One rundown entry per incident, in the given order. Never reorder, merge, split, add or drop an incident.`,
    `- Headline: ${template.entry.headline.style}. ${template.entry.headline.rule}`,
    `- Summary: ${template.entry.summary.sentences.min} to ${template.entry.summary.sentences.max} sentences.`,
    summaryRules,
    `- ${template.deduplication.rule}`,
    `- sources: every member row's url, exactly as given, in row order, nothing else.`,
    `- citations: every member row's sourceRowId, in row order.`,
    '- Use only what the recorded fields say. Add no fact, name, number, date or quotation the rows do not contain.',
    '- Name organizations as the recorded fields name them.',
    '- Headline and summary are plain prose on one line: no line breaks, no Markdown, no HTML, no links and no URLs; the sources array is the only place a URL appears.',
    '- extras: return the provided marker exactly as given.',
  ].join('\n');
}

export function promptHash(template: RundownTemplate): string {
  return sha256(systemPrompt(template));
}

/**
 * The user turn: the selected incidents' recorded fields as JSON, plus the
 * marker to echo. The flagged entries, whose reasons are editorial notes, are
 * not part of it (review F1): only selected stories' recorded fields cross.
 */
export function userPrompt(input: RoundupInput, extrasMarker: string): string {
  return JSON.stringify({
    weekRunId: input.weekRunId,
    category: input.category,
    window: { start: input.windowStart, end: input.windowEnd },
    incidents: input.incidents,
    extras: extrasMarker,
  });
}
