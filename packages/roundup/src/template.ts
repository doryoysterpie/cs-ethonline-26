import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { canonicalize, deepFreeze, sha256 } from './canonical.js';
import { RoundupError } from './errors.js';

/**
 * The rundown template (D40): structure only, read from the committed policy
 * file, canonicalized and hashed. A generated revision records the hash it
 * was produced under; a request naming another hash is refused. The path
 * argument exists for tests only.
 */
export const TEMPLATE_PATH = fileURLToPath(
  new URL('../../../data/policy/rundown-template.json', import.meta.url),
);

export const TEMPLATE_VERSION_PATTERN = /^rundown-template@[0-9]+$/u;

export interface TemplateSection {
  readonly id: 'rundown' | 'extras' | 'flagged';
  readonly title: string;
  readonly rule: string;
  readonly manual?: boolean;
  readonly marker?: string;
}

export interface RundownTemplate {
  readonly version: string;
  readonly sections: readonly TemplateSection[];
  readonly entry: {
    readonly headline: { readonly style: string; readonly rule: string };
    readonly summary: {
      readonly sentences: { readonly min: number; readonly max: number };
      readonly rules: readonly string[];
    };
    readonly sources: { readonly label: string; readonly rule: string };
  };
  readonly deduplication: { readonly rule: string };
}

export interface LoadedTemplate {
  readonly template: RundownTemplate;
  readonly canonical: string;
  readonly hash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string): RoundupError {
  return new RoundupError('template_invalid', `the rundown template is invalid: ${message}`);
}

/** Checks the shape the generator relies on; the owner's wording is free text. */
export function parseTemplate(parsed: unknown): RundownTemplate {
  if (!isRecord(parsed)) throw invalid('not an object');
  const version = parsed['version'];
  if (typeof version !== 'string' || !TEMPLATE_VERSION_PATTERN.test(version)) {
    throw invalid('version must read rundown-template@<integer>');
  }
  const sections = parsed['sections'];
  if (!Array.isArray(sections) || sections.length !== 3) throw invalid('three sections expected');
  const ids = new Set<string>();
  const parsedSections: TemplateSection[] = [];
  for (const section of sections) {
    if (!isRecord(section)) throw invalid('a section is not an object');
    const id = section['id'];
    const title = section['title'];
    const rule = section['rule'];
    if (id !== 'rundown' && id !== 'extras' && id !== 'flagged')
      throw invalid('unknown section id');
    if (typeof title !== 'string' || typeof rule !== 'string')
      throw invalid('a section lacks its title or rule');
    if (ids.has(id)) throw invalid('a section id repeats');
    ids.add(id);
    const manual = section['manual'];
    const marker = section['marker'];
    if (id === 'extras' && (manual !== true || typeof marker !== 'string' || marker.length === 0)) {
      throw invalid('the extras section must be manual and carry its marker');
    }
    parsedSections.push({
      id,
      title,
      rule,
      ...(manual === true ? { manual: true } : {}),
      ...(typeof marker === 'string' ? { marker } : {}),
    });
  }
  const entry = parsed['entry'];
  if (!isRecord(entry)) throw invalid('entry missing');
  const headline = entry['headline'];
  const summary = entry['summary'];
  const sources = entry['sources'];
  if (
    !isRecord(headline) ||
    typeof headline['style'] !== 'string' ||
    typeof headline['rule'] !== 'string'
  ) {
    throw invalid('entry.headline lacks style or rule');
  }
  if (!isRecord(summary) || !isRecord(summary['sentences']) || !Array.isArray(summary['rules'])) {
    throw invalid('entry.summary lacks sentences or rules');
  }
  const sentences = summary['sentences'];
  const min = sentences['min'];
  const max = sentences['max'];
  if (
    !Number.isInteger(min) ||
    !Number.isInteger(max) ||
    (min as number) < 1 ||
    (max as number) < (min as number)
  ) {
    throw invalid('entry.summary.sentences must be a positive integer range');
  }
  const rules = (summary['rules'] as unknown[]).filter(
    (rule): rule is string => typeof rule === 'string',
  );
  if (rules.length !== (summary['rules'] as unknown[]).length || rules.length === 0) {
    throw invalid('entry.summary.rules must be non-empty strings');
  }
  if (
    !isRecord(sources) ||
    typeof sources['label'] !== 'string' ||
    typeof sources['rule'] !== 'string'
  ) {
    throw invalid('entry.sources lacks label or rule');
  }
  const deduplication = parsed['deduplication'];
  if (!isRecord(deduplication) || typeof deduplication['rule'] !== 'string') {
    throw invalid('deduplication rule missing');
  }
  return deepFreeze({
    version,
    sections: parsedSections,
    entry: {
      headline: { style: headline['style'], rule: headline['rule'] },
      summary: { sentences: { min: min as number, max: max as number }, rules },
      sources: { label: sources['label'], rule: sources['rule'] },
    },
    deduplication: { rule: deduplication['rule'] },
  });
}

export async function loadTemplate(path: string = TEMPLATE_PATH): Promise<LoadedTemplate> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw invalid('the file could not be read as JSON');
  }
  const template = parseTemplate(parsed);
  const canonical = canonicalize(template);
  return deepFreeze({ template, canonical, hash: sha256(canonical) });
}

export function sectionOf(template: RundownTemplate, id: TemplateSection['id']): TemplateSection {
  const section = template.sections.find((candidate) => candidate.id === id);
  if (section === undefined) throw invalid(`section ${id} missing`);
  return section;
}
