import { canonicalize, sha256 } from './canonical.js';
import { RoundupError } from './errors.js';

/**
 * The selection snapshot (report, section 1.3): the recorded fields of the
 * selected incidents' member rows, in selection order, and the deterministic
 * flagged entries. Nothing else crosses to the model.
 */

export interface SelectedRow {
  readonly sourceRowId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly url: string;
  readonly publisher: string;
  readonly postedAt: string | null;
}

export interface SelectedIncident {
  readonly incidentId: string;
  /** In row order, as the selection recorded them. */
  readonly rows: readonly SelectedRow[];
}

export interface FlaggedEntry {
  readonly incidentId: string;
  readonly headline: string;
  readonly reason: string;
  readonly disposition: 'omit' | 'carry';
}

export interface RoundupInput {
  readonly weekRunId: string;
  readonly category: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  /** Selected incidents in selection order; the generator never reorders them. */
  readonly incidents: readonly SelectedIncident[];
  readonly flagged: readonly FlaggedEntry[];
}

export const INPUT_LIMITS = {
  incidents: 200,
  rowsPerIncident: 50,
  titleCharacters: 1_000,
  summaryCharacters: 8_000,
  urlCharacters: 2_048,
  publisherCharacters: 253,
  reasonCharacters: 2_000,
  /** The stored slot schema admits 200 flagged entries; an input past that can satisfy no revision (review F6). */
  flagged: 200,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function invalid(message: string): RoundupError {
  return new RoundupError('input_invalid', `the round-up input is invalid: ${message}`);
}

/** Refuses an input the contract does not allow, before any digest or prompt is built. */
export function assertRoundupInput(input: RoundupInput): void {
  if (!UUID.test(input.weekRunId)) throw invalid('week run id');
  if (!/^[a-z][a-z0-9_]{1,31}$/u.test(input.category)) throw invalid('category');
  if (Number.isNaN(Date.parse(input.windowStart)) || Number.isNaN(Date.parse(input.windowEnd))) {
    throw invalid('window');
  }
  if (input.incidents.length === 0) {
    throw new RoundupError('input_empty', 'the selection holds no incident; nothing to round up');
  }
  if (input.incidents.length > INPUT_LIMITS.incidents) throw invalid('too many incidents');
  const seen = new Set<string>();
  const rowIds = new Set<string>();
  for (const incident of input.incidents) {
    if (!UUID.test(incident.incidentId)) throw invalid('incident id');
    if (seen.has(incident.incidentId)) throw invalid('an incident repeats');
    seen.add(incident.incidentId);
    if (incident.rows.length === 0 || incident.rows.length > INPUT_LIMITS.rowsPerIncident) {
      throw invalid('an incident has no rows or too many');
    }
    for (const row of incident.rows) {
      if (!UUID.test(row.sourceRowId)) throw invalid('source row id');
      if (rowIds.has(row.sourceRowId)) throw invalid('a source row repeats');
      rowIds.add(row.sourceRowId);
      if (row.title.length === 0 || row.title.length > INPUT_LIMITS.titleCharacters)
        throw invalid('title length');
      if (row.summary !== null && row.summary.length > INPUT_LIMITS.summaryCharacters)
        throw invalid('summary length');
      if (row.url.length === 0 || row.url.length > INPUT_LIMITS.urlCharacters)
        throw invalid('url length');
      if (row.publisher.length === 0 || row.publisher.length > INPUT_LIMITS.publisherCharacters)
        throw invalid('publisher length');
    }
  }
  if (input.flagged.length > INPUT_LIMITS.flagged) throw invalid('too many flagged entries');
  for (const entry of input.flagged) {
    if (!UUID.test(entry.incidentId) || seen.has(entry.incidentId))
      throw invalid('a flagged entry names a selected incident');
    if (entry.headline.length === 0 || entry.headline.length > INPUT_LIMITS.titleCharacters)
      throw invalid('flagged headline length');
    if (entry.reason.length === 0 || entry.reason.length > INPUT_LIMITS.reasonCharacters)
      throw invalid('flagged reason length');
    if (entry.disposition !== 'omit' && entry.disposition !== 'carry')
      throw invalid('flagged disposition');
  }
}

/** SHA-256 of the canonical snapshot: what the model saw, matchable later. */
export function inputDigest(input: RoundupInput): string {
  return sha256(canonicalize(input));
}

/** The host of a recorded URL, the publisher the entry names; never the URL's path. */
export function publisherOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
}
