import { canonicalize, sha256 } from './canonical.js';
import { ArticleError } from './errors.js';

/**
 * The article's input (report, section 1.6): per selected incident, in
 * selection order, each member row's recorded fields and what the reading
 * stage left of its page: the extracted text when read, the outcome code
 * when not. Nothing else crosses to the model: no note, no row outside the
 * selection, no page that is not a selected source.
 */

export type ReadingStatus = 'read' | 'partly_read' | 'not_read';

export interface SourceReading {
  readonly status: ReadingStatus;
  /** The reader's fixed code when the page is incomplete or unread; null when read in full. */
  readonly code: string | null;
  /** The extracted text, bounded by the reader; null when not read. */
  readonly text: string | null;
  /** SHA-256 of the extracted text; null when not read. */
  readonly digest: string | null;
  readonly bytes: number;
}

export interface ArticleRow {
  readonly sourceRowId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly url: string;
  readonly publisher: string;
  readonly postedAt: string | null;
  readonly reading: SourceReading;
}

export interface ArticleIncident {
  readonly incidentId: string;
  readonly rows: readonly ArticleRow[];
}

export interface ArticleInput {
  readonly weekRunId: string;
  readonly category: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly incidents: readonly ArticleIncident[];
}

export const INPUT_LIMITS = {
  incidents: 200,
  rowsPerIncident: 50,
  titleCharacters: 1_000,
  summaryCharacters: 8_000,
  urlCharacters: 2_048,
  publisherCharacters: 253,
  textCharactersPerSource: 60_000,
  textCharactersPerInput: 600_000,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;
const CODE = /^[a-z][a-z0-9_]{1,63}$/u;

function invalid(message: string): ArticleError {
  return new ArticleError('input_invalid', `the article input is invalid: ${message}`);
}

/** Refuses an input the contract does not allow, before any digest or prompt is built. */
export function assertArticleInput(input: ArticleInput): void {
  if (!UUID.test(input.weekRunId)) throw invalid('week run id');
  if (!/^[a-z][a-z0-9_]{1,31}$/u.test(input.category)) throw invalid('category');
  if (Number.isNaN(Date.parse(input.windowStart)) || Number.isNaN(Date.parse(input.windowEnd))) {
    throw invalid('window');
  }
  if (input.incidents.length === 0) {
    throw new ArticleError('input_empty', 'the selection holds no incident; nothing to write');
  }
  if (input.incidents.length > INPUT_LIMITS.incidents) throw invalid('too many incidents');
  const incidents = new Set<string>();
  const rowIds = new Set<string>();
  let readRows = 0;
  let textCharacters = 0;
  for (const incident of input.incidents) {
    if (!UUID.test(incident.incidentId)) throw invalid('incident id');
    if (incidents.has(incident.incidentId)) throw invalid('an incident repeats');
    incidents.add(incident.incidentId);
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
      const reading = row.reading;
      if (reading.bytes < 0 || !Number.isInteger(reading.bytes)) throw invalid('bytes');
      if (reading.code !== null && !CODE.test(reading.code)) throw invalid('reading code');
      if (reading.status === 'not_read') {
        if (reading.text !== null || reading.digest !== null || reading.code === null)
          throw invalid('an unread source carries text or no code');
        continue;
      }
      if (reading.status !== 'read' && reading.status !== 'partly_read')
        throw invalid('reading status');
      if (reading.text === null || reading.digest === null)
        throw invalid('a read source has no text');
      if (reading.status === 'partly_read' && reading.code === null)
        throw invalid('a partly read source has no code');
      if (reading.status === 'read' && reading.code !== null)
        throw invalid('a source read in full carries a code');
      if (reading.text.length === 0 || reading.text.length > INPUT_LIMITS.textCharactersPerSource)
        throw invalid('text length');
      if (!HASH.test(reading.digest) || sha256(reading.text) !== reading.digest)
        throw invalid('text digest');
      readRows += 1;
      textCharacters += reading.text.length;
    }
  }
  if (readRows === 0) {
    throw new ArticleError(
      'input_empty',
      'no selected source could be read; nothing to write from',
    );
  }
  if (textCharacters > INPUT_LIMITS.textCharactersPerInput) {
    throw new ArticleError('input_too_large', 'the texts read exceed the input bound', {
      characters: textCharacters,
    });
  }
}

/** SHA-256 of the canonical input, texts included: what the model saw, matchable later. */
export function inputDigest(input: ArticleInput): string {
  return sha256(canonicalize(input));
}

/** The rows the model may cite: those read in full or in part. */
export function readableRows(input: ArticleInput): ArticleRow[] {
  return input.incidents.flatMap((incident) =>
    incident.rows.filter((row) => row.reading.status !== 'not_read'),
  );
}

/** The rows the model was told were not read, in order. */
export function unreadRows(input: ArticleInput): ArticleRow[] {
  return input.incidents.flatMap((incident) =>
    incident.rows.filter((row) => row.reading.status === 'not_read'),
  );
}
