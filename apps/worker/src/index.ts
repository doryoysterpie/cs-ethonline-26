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
  IMPORT_LIMIT_CODES,
  readCsv,
  resolveImportLimits,
  translateStreamError,
  type CsvHandlers,
  type CsvReadOptions,
  type CsvStreamStats,
  type ImportLimitCode,
} from './editorial/csv-stream.js';
export {
  armCommandDeadline,
  COMMAND_DEADLINE_VARIABLE,
  resolveCommandDeadline,
  type ArmedDeadline,
  type CommandDeadline,
  type DeadlineHooks,
  type DeadlineTimers,
} from './deadline.js';
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
export {
  formatCalibration,
  formatClassificationRun,
  formatQueue,
  formatRunReport,
} from './classification/output.js';
export {
  calibrateRun,
  reportRun,
  reviewQueue,
  type CalibrationReport,
  type QueueSummary,
  type RunReport,
} from './classification/report.js';
export {
  classifyBatch,
  computeRunIdempotencyKey,
  DEFAULT_PAGE_SIZE,
  type ClassifyBatchOptions,
  type ClassifyBatchOutcome,
  type ClassifyBatchRequest,
  type IdempotencyInputs as RunIdempotencyInputs,
} from './classification/run.js';
export {
  formatClusteringReport,
  formatClusteringRun,
  formatEffectiveView,
  formatReviewAction,
  formatReviewCounts,
} from './clustering/output.js';
export { reportClusteringRun, type ClusteringReport } from './clustering/report.js';
export {
  effectiveIncidents,
  mergeIncidents,
  reviewCounts,
  splitIncident,
  MAX_MERGE_INCIDENTS,
  MAX_SPLIT_MEMBERSHIPS,
  type EffectiveIncident,
  type EffectiveView,
  type ReviewActionOutcome,
  type ReviewCounts,
} from './clustering/review.js';
export {
  clusterClassificationRun,
  computeClusteringIdempotencyKey,
  DEFAULT_PAGE_SIZE as CLUSTERING_PAGE_SIZE,
  type ClusterRunOptions,
  type ClusterRunOutcome,
  type ClusterRunRequest,
} from './clustering/run.js';
export { buildAnomalyFeed, type AnomalyRequest } from './evidence/anomaly.js';
export {
  reportEvidenceRun,
  resolveEvidence,
  type EvidenceReport,
  type EvidenceRunOutcome,
  type EvidenceRunRequest,
} from './evidence/run.js';
// The Sprint 5 audit correction (F1, decision D26) split ingestion into two
// functions whose input types share no field but a discriminant, so that a
// file can never be ingested as live. The public surface follows: the file
// path and the Graph-client path are both exported, and the single
// `ingestSnapshot` they replaced is deliberately gone rather than aliased —
// an alias would put the pre-correction name back in reach.
export {
  assertFileIngestInput,
  ingestLiveEvaluations,
  ingestSnapshotFile,
  type FileIngestInput,
  type FileOrigin,
  type GraphClientIngestInput,
  type IngestSnapshotOutcome,
  type LiveTargetEvaluation,
} from './evidence/signals.js';
export {
  recordIncidentSubject,
  type RecordSubjectOutcome,
  type RecordSubjectRequest,
} from './evidence/subject.js';
export {
  decideAssociation,
  evidenceReviewCounts,
  type EvidenceDecisionOutcome,
  type EvidenceDecisionRequest,
} from './evidence/review.js';
export { buildDraftRequest, type BuildDraftRequest } from './drafting/build.js';
export {
  assertReviewNote,
  REVIEW_NOTE_MAX_LENGTH,
  REVIEW_NOTE_MIN_LENGTH,
} from './clustering/note.js';
export { run, type CliIo, type CliOptions } from './cli.js';
