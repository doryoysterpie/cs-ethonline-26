import { safeDisplay } from './display.js';
import { fail } from './errors.js';
import type { SheetsLimits } from './limits.js';
import { stableDigest } from './redact.js';

/**
 * Reading a tab's shape without reading its contents.
 *
 * Header analysis is deliberately descriptive and never corrective. A blank
 * header stays blank, a duplicate stays duplicated, and both are reported with
 * their positions. Repairing them here would hide exactly the structural
 * variation the inventory exists to find, and the owner has said plainly that
 * the historical tabs do not all share a layout.
 *
 * Tab-type inference is a guess, and it is typed as one. Every inference
 * carries a confidence and the evidence behind it, and no caller may treat it
 * as a fact: the ingestion adapter takes an explicit mapping the owner
 * approved, never an inference this module produced.
 */

/** A header cell, exactly as found and as it may be displayed. */
export interface HeaderCell {
  /** One-based column position. */
  readonly column: number;
  /** Column letters, for a human reading the report beside the workbook. */
  readonly letters: string;
  /** The header rendered safe for one line of output. */
  readonly display: string;
  /** Lower-case, whitespace-collapsed form used for duplicate detection only. */
  readonly normalized: string;
  /** True when the cell held nothing, or only whitespace. */
  readonly blank: boolean;
  /** True when the original carried a character that could forge a line. */
  readonly sanitized: boolean;
}

export interface HeaderAnalysis {
  readonly headers: readonly HeaderCell[];
  /** Normalized names appearing more than once, with every position. */
  readonly duplicates: readonly {
    readonly normalized: string;
    readonly columns: readonly number[];
  }[];
  /** Positions of blank headers. */
  readonly blankColumns: readonly number[];
  /** True when any header had to be escaped for display. */
  readonly anySanitized: boolean;
}

function normalizeHeader(value: unknown): string {
  if (typeof value !== 'string') return typeof value === 'number' ? String(value) : '';
  return value.replace(/\s+/gu, ' ').trim().toLowerCase();
}

function rawHeader(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** One-based column index to letters. Duplicated from `a1` deliberately: this
 * module must not be able to build a range. */
function letters(index: number): string {
  let remaining = index;
  let out = '';
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return out;
}

/** Describes a header row. Deterministic: the same row always reports the same. */
export function analyzeHeaders(row: readonly unknown[], limits: SheetsLimits): HeaderAnalysis {
  if (row.length > limits.maximumColumnsPerTab) {
    throw fail.structural(
      'header_too_many_columns',
      'the header row declares more columns than the configured bound permits',
      { columns: row.length, maximum: limits.maximumColumnsPerTab },
    );
  }
  const headers: HeaderCell[] = [];
  const positions = new Map<string, number[]>();
  const blankColumns: number[] = [];

  for (const [index, cell] of row.entries()) {
    const column = index + 1;
    const raw = rawHeader(cell);
    if (raw.length > limits.maximumHeaderCharacters) {
      throw fail.structural(
        'header_too_long',
        'a header cell exceeds the configured length bound',
        { column, length: raw.length, maximum: limits.maximumHeaderCharacters },
      );
    }
    const normalized = normalizeHeader(cell);
    const display = safeDisplay(raw);
    const blank = normalized.length === 0;
    if (blank) blankColumns.push(column);
    else positions.set(normalized, [...(positions.get(normalized) ?? []), column]);
    headers.push({
      column,
      letters: letters(column),
      display,
      normalized,
      blank,
      sanitized: display !== raw,
    });
  }

  const duplicates = [...positions.entries()]
    .filter(([, columns]) => columns.length > 1)
    .map(([normalized, columns]) => ({ normalized, columns }))
    .sort((a, b) => (a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0));

  return {
    headers,
    duplicates,
    blankColumns,
    anySanitized: headers.some((header) => header.sanitized),
  };
}

/** What a tab provisionally looks like. Never a fact; always a hypothesis. */
export const TAB_HYPOTHESES = ['rss_source_corpus', 'weekly_candidates', 'unclassified'] as const;
export type TabHypothesis = (typeof TAB_HYPOTHESES)[number];

export interface TabInference {
  readonly hypothesis: TabHypothesis;
  /** Zero to one. Never presented without the word provisional beside it. */
  readonly confidence: number;
  /** The normalized header names that led here. Evidence, not proof. */
  readonly evidence: readonly string[];
  /** Always true. The field exists so a consumer must acknowledge it. */
  readonly provisional: true;
}

/** Header names that suggest a full feed export rather than a weekly cut-down. */
const CORPUS_MARKERS = ['guid', 'feed', 'feed url', 'source feed', 'rss', 'pubdate', 'published'];
/** Header names that suggest an editorial selection step. */
const WEEKLY_MARKERS = ['ch', 'include', 'selected', 'use', 'keep', 'week', 'edition', 'review'];

/**
 * Guesses what a tab holds from its headers alone.
 *
 * The tab's own name is deliberately not evidence. The owner named these tabs
 * after the publication, and a name that says "Cyberattack Sunday" tells you
 * what the week was called, not what stage of the lineage the rows belong to.
 * Inferring from the name would encode exactly the category error this track
 * is meant to avoid.
 */
export function inferTabType(analysis: HeaderAnalysis): TabInference {
  const present = new Set(analysis.headers.filter((h) => !h.blank).map((h) => h.normalized));
  const corpusHits = CORPUS_MARKERS.filter((marker) => present.has(marker));
  const weeklyHits = WEEKLY_MARKERS.filter((marker) => present.has(marker));

  if (weeklyHits.length > corpusHits.length && weeklyHits.length > 0) {
    return {
      hypothesis: 'weekly_candidates',
      confidence: Math.min(0.8, 0.3 + weeklyHits.length * 0.15),
      evidence: weeklyHits,
      provisional: true,
    };
  }
  if (corpusHits.length > 0) {
    return {
      hypothesis: 'rss_source_corpus',
      confidence: Math.min(0.8, 0.3 + corpusHits.length * 0.15),
      evidence: corpusHits,
      provisional: true,
    };
  }
  return { hypothesis: 'unclassified', confidence: 0, evidence: [], provisional: true };
}

/**
 * A stable, non-reversible label for a tab.
 *
 * Reports name a tab by its sanitized title where that is safe, and by this
 * digest where it is not, so two runs over the same workbook can be compared
 * without the report ever carrying an unsanitized name.
 */
export function tabDigest(title: string): string {
  return stableDigest(title);
}
