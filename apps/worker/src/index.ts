/**
 * @cas/worker
 *
 * Sprint 2: the editorial ingestion path. Streaming CSV reading and
 * validation, pure row evaluation, URL canonicalization for matching, derived
 * plain text through a maintained HTML parser, and a manual on-demand import
 * into PostgreSQL through the operations `@cas/database` exports (decision
 * D20). The command-line interface is `src/cli.ts`. Classification, queue
 * routing, clustering and Graph correlation arrive with later sprints.
 */

export {
  DEFAULT_CHUNK_SIZE,
  IMPORTER_VERSION,
  ISSUE_CODES,
  KNOWN_HEADERS,
  REQUIRED_HEADERS,
  type IssueCode,
  type KnownHeader,
} from './editorial/constants.js';
export {
  readCsv,
  translateStreamError,
  type CsvHandlers,
  type CsvReadOptions,
  type CsvStreamStats,
} from './editorial/csv-stream.js';
export {
  EXIT_CODES,
  exitCodeFor,
  INGESTION_FAILURE_KINDS,
  IngestionError,
  isIngestionError,
  type IngestionFailureKind,
} from './editorial/errors.js';
export {
  cellFor,
  normalizeHeaderName,
  resolveHeaderLayout,
  type HeaderLayout,
} from './editorial/headers.js';
export {
  DISPLAY_MAX_LENGTH,
  ESCAPE_CHARACTER,
  hasControlCharacter,
  MAX_BASENAME_LENGTH,
  MAX_REVIEW_LABEL_LENGTH,
  safeDisplay,
  toSingleLine,
} from './editorial/display.js';
export { htmlToText, TEXT_TRANSFORM } from './editorial/html-text.js';
export {
  assertImportRequest,
  computeIdempotencyKey,
  importCsvFile,
  type IdempotencyInputs,
  type ImportOptions,
  type ImportOutcome,
  type ImportRequest,
} from './editorial/import.js';
export {
  formatBatchReport,
  formatError,
  formatImportOutcome,
  formatValidation,
} from './editorial/output.js';
export { reportBatches, type BatchReport } from './editorial/report.js';
export {
  evaluateRow,
  hashRow,
  type RawFieldSet,
  type RowEvaluation,
  type RowIssue,
  type WeeklyReview,
} from './editorial/rows.js';
export { parseStrictTimestamp, type TimestampParse } from './editorial/timestamps.js';
export {
  canonicalizeUrl,
  TRACKING_PARAMETER_PREFIXES,
  TRACKING_PARAMETERS,
  type UrlCanonicalization,
  type UrlFailureCode,
} from './editorial/urls.js';
export {
  inspectCsvFile,
  validateCsvFile,
  type ChCounts,
  type IssueCount,
  type StructuralSummary,
  type ValidateOptions,
  type ValidationReport,
} from './editorial/validate.js';
export { run, type CliIo, type CliOptions } from './cli.js';
