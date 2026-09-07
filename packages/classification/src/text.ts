import type { ClassificationInput } from './input.js';

/**
 * Deterministic assembly and normalization of the text the rules read.
 *
 * Versioned, because a change here changes every decision: the version is
 * part of the ruleset hash. The complete normalized derived fields are
 * evaluated; nothing is truncated, so a 48,000-character summary is matched
 * end to end exactly like a short one.
 */
export const TEXT_ASSEMBLY_VERSION = 'classification-text-assembly@1';

/** Field order is fixed and part of the version. */
export const TEXT_FIELD_ORDER = [
  'normalizedTitle',
  'derivedSummaryText',
  'derivedDescriptionText',
] as const;

const WHITESPACE = /\s+/gu;

/**
 * Unicode NFC, lower case, whitespace collapsed to single spaces, trimmed.
 * Case folding uses the locale-independent `toLowerCase`, so the result does
 * not depend on the machine's locale.
 */
export function normalizeForMatching(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(WHITESPACE, ' ').trim();
}

/**
 * Joins the three fields in the fixed order with a newline, so a phrase
 * cannot be formed accidentally across a field boundary. Absent and
 * whitespace-only fields contribute nothing.
 */
export function assembleText(input: ClassificationInput): string {
  const parts: string[] = [];
  for (const field of TEXT_FIELD_ORDER) {
    const raw = input[field];
    if (raw === null) continue;
    const normalized = normalizeForMatching(raw);
    if (normalized.length > 0) parts.push(normalized);
  }
  return parts.join('\n');
}
