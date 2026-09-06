import { createHash } from 'node:crypto';

import type {
  EditorialSourceKind,
  ReviewState,
  RowIssueSeverity,
  SourceRowStatus,
} from '@cas/contracts';

import {
  ISSUE_CODES,
  REVIEW_TOKEN_REJECTED,
  REVIEW_TOKEN_SELECTED,
  type IssueCode,
} from './constants.js';
import { cellFor, type HeaderLayout } from './headers.js';
import { htmlToText, TEXT_TRANSFORM } from './html-text.js';
import { parseStrictTimestamp } from './timestamps.js';
import { canonicalizeUrl } from './urls.js';

/**
 * Pure evaluation of one logical CSV row. No database, no network. The raw
 * cells are carried unchanged; every parsed, normalized or derived value is a
 * separate property; issues carry fixed messages and never source content.
 * Weekly review state is produced only for weekly files and only from the
 * documented tokens; the master sheet's `ch` is stored raw and never becomes
 * review state (docs/DATA_INPUTS.md section 3, decision D20).
 */

export interface RowIssue {
  readonly code: IssueCode;
  readonly field: string | null;
  readonly severity: RowIssueSeverity;
  readonly message: string;
}

export interface WeeklyReview {
  readonly rawValue: string;
  readonly state: ReviewState;
}

export interface RawFieldSet {
  readonly ch: string | null;
  readonly datePosted: string | null;
  readonly dateUpdated: string | null;
  readonly title: string | null;
  readonly author: string | null;
  readonly description: string | null;
  readonly summary: string | null;
  readonly url: string | null;
  readonly category: string | null;
}

export interface RowEvaluation {
  readonly rowNumber: number;
  readonly rawCells: readonly string[];
  /** Every non-blank header, known or unknown, mapped to its exact cell. */
  readonly rawFields: Readonly<Record<string, string>>;
  readonly raw: RawFieldSet;
  readonly postedAt: string | null;
  readonly updatedAt: string | null;
  readonly normalizedTitle: string | null;
  readonly derivedSummaryText: string | null;
  readonly derivedDescriptionText: string | null;
  readonly textTransform: string;
  readonly canonicalUrl: string | null;
  readonly rowHash: string;
  readonly issues: readonly RowIssue[];
  readonly status: SourceRowStatus;
  readonly review: WeeklyReview | null;
}

const MESSAGES: Readonly<Record<IssueCode, string>> = {
  title_missing: 'Title is empty',
  url_missing: 'URL is empty',
  url_invalid: 'URL cannot be parsed',
  url_scheme_not_allowed: 'URL scheme is not http or https',
  timestamp_missing: 'timestamp is empty',
  timestamp_invalid: 'timestamp is not a strict timezone-aware ISO 8601 value',
  review_value_unknown: 'weekly ch value is not TRUE, FALSE or blank; no review state recorded',
  ch_token_unrecognized:
    'master ch value is not TRUE, FALSE or blank; stored as working state only',
};

function issue(code: IssueCode, field: string | null, severity: RowIssueSeverity): RowIssue {
  return { code, field, severity, message: MESSAGES[code] };
}

export function hashRow(cells: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(cells)).digest('hex');
}

function isBlank(value: string | null): boolean {
  return value === null || value.trim().length === 0;
}

function normalizeTitle(raw: string | null): string | null {
  if (raw === null) return null;
  const text = htmlToText(raw);
  if (text === null) return null;
  return text.replace(/\s+/g, ' ').trim();
}

function evaluateTimestamp(raw: string | null, field: string, issues: RowIssue[]): string | null {
  if (raw === null) return null;
  if (isBlank(raw)) {
    issues.push(issue(ISSUE_CODES.timestampMissing, field, 'error'));
    return null;
  }
  const parsed = parseStrictTimestamp(raw.trim());
  if (!parsed.ok) {
    issues.push(issue(ISSUE_CODES.timestampInvalid, field, 'error'));
    return null;
  }
  return parsed.isoUtc;
}

function evaluateUrl(raw: string | null, issues: RowIssue[]): string | null {
  const result = canonicalizeUrl(raw ?? '');
  if (result.ok) return result.canonical;
  issues.push(issue(result.code, 'URL', 'error'));
  return null;
}

function evaluateReview(
  sourceKind: EditorialSourceKind,
  rawCh: string | null,
  issues: RowIssue[],
): WeeklyReview | null {
  const token = (rawCh ?? '').trim();
  const recognized =
    token === REVIEW_TOKEN_SELECTED || token === REVIEW_TOKEN_REJECTED || token.length === 0;
  if (sourceKind === 'master') {
    if (!recognized) issues.push(issue(ISSUE_CODES.chTokenUnrecognized, 'ch', 'warning'));
    return null;
  }
  if (!recognized) {
    issues.push(issue(ISSUE_CODES.reviewValueUnknown, 'ch', 'error'));
    return null;
  }
  const state: ReviewState =
    token === REVIEW_TOKEN_SELECTED
      ? 'selected'
      : token === REVIEW_TOKEN_REJECTED
        ? 'rejected'
        : 'unreviewed';
  return { rawValue: rawCh ?? '', state };
}

export function evaluateRow(
  rowNumber: number,
  cells: readonly string[],
  layout: HeaderLayout,
  sourceKind: EditorialSourceKind,
): RowEvaluation {
  const rawFields: Record<string, string> = {};
  for (const [name, index] of layout.named) rawFields[name] = cells[index] ?? '';
  const raw: RawFieldSet = {
    ch: cellFor(layout, cells, 'ch'),
    datePosted: cellFor(layout, cells, 'Date Posted'),
    dateUpdated: cellFor(layout, cells, 'Date Updated'),
    title: cellFor(layout, cells, 'Title'),
    author: cellFor(layout, cells, 'Author'),
    description: cellFor(layout, cells, 'Description'),
    summary: cellFor(layout, cells, 'Summary'),
    url: cellFor(layout, cells, 'URL'),
    category: cellFor(layout, cells, 'Category'),
  };
  const issues: RowIssue[] = [];
  if (isBlank(raw.title)) issues.push(issue(ISSUE_CODES.titleMissing, 'Title', 'error'));
  const postedAt = evaluateTimestamp(raw.datePosted, 'Date Posted', issues);
  const updatedAt = evaluateTimestamp(raw.dateUpdated, 'Date Updated', issues);
  const canonicalUrl = evaluateUrl(raw.url, issues);
  const review = evaluateReview(sourceKind, raw.ch, issues);
  const status: SourceRowStatus = issues.some((i) => i.severity === 'error')
    ? 'quarantined'
    : 'accepted';
  return {
    rowNumber,
    rawCells: cells,
    rawFields,
    raw,
    postedAt,
    updatedAt,
    normalizedTitle: normalizeTitle(raw.title),
    derivedSummaryText: raw.summary === null ? null : htmlToText(raw.summary),
    derivedDescriptionText: raw.description === null ? null : htmlToText(raw.description),
    textTransform: TEXT_TRANSFORM,
    canonicalUrl,
    rowHash: hashRow(cells),
    issues,
    status,
    review,
  };
}
