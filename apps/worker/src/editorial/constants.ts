/**
 * Fixed vocabulary of the editorial importer. Header names are the exact
 * column names of the exports (docs/DATA_INPUTS.md section 2); fields are
 * recognized by normalized header name, never by position.
 */

/** Version of the parsing, validation and canonicalization rules. Part of every idempotency key. */
export const IMPORTER_VERSION = 'editorial-csv-import@1';

export const KNOWN_HEADERS = [
  'ch',
  'Date Posted',
  'Date Updated',
  'Title',
  'Author',
  'Description',
  'Summary',
  'URL',
  'Category',
] as const;
export type KnownHeader = (typeof KNOWN_HEADERS)[number];

/** Headers every accepted file must carry. The others are optional and recognized when present. */
export const REQUIRED_HEADERS = ['ch', 'Date Posted', 'Date Updated', 'Title', 'URL'] as const;

/** Stable machine-readable row issue codes. Adding one is a reviewed change. */
export const ISSUE_CODES = {
  titleMissing: 'title_missing',
  urlMissing: 'url_missing',
  urlInvalid: 'url_invalid',
  urlSchemeNotAllowed: 'url_scheme_not_allowed',
  timestampMissing: 'timestamp_missing',
  timestampInvalid: 'timestamp_invalid',
  reviewValueUnknown: 'review_value_unknown',
  chTokenUnrecognized: 'ch_token_unrecognized',
} as const;
export type IssueCode = (typeof ISSUE_CODES)[keyof typeof ISSUE_CODES];

/** Weekly review tokens as exported. Exact after trimming; anything else is unknown. */
export const REVIEW_TOKEN_SELECTED = 'TRUE';
export const REVIEW_TOKEN_REJECTED = 'FALSE';

/** Rows evaluated before one multi-statement flush to the database. */
export const DEFAULT_CHUNK_SIZE = 100;
