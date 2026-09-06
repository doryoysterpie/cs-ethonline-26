/**
 * @cas/database
 *
 * The only package that talks to PostgreSQL (docs/ARCHITECTURE.md section 2).
 * Sprint 2: connection configuration read from DATABASE_URL and never echoed,
 * a forward-only checksummed migration runner with an advisory lock, and
 * parameterized operations over the editorial ingestion tables. CSV parsing
 * and import orchestration live in @cas/worker and call these operations.
 */

export {
  assertCredentialPolicy,
  assertSchemaName,
  DATABASE_URL_VARIABLE,
  MINIMUM_PASSWORD_LENGTH,
  parseDatabaseConfig,
  summarizeConnection,
  type ConnectionSummary,
  type ConnectionTransport,
  type DatabaseConfig,
} from './config.js';
export { Database, openDatabase, type DatabaseOptions, type Queryable } from './database.js';
export {
  classifyDriverError,
  DATABASE_FAILURE_KINDS,
  DatabaseError,
  isDatabaseError,
  type DatabaseFailureKind,
  type SafeDetailValue,
} from './errors.js';
export {
  countAllRows,
  countRowIssues,
  countSourceRows,
  ensureUrlGroups,
  finalizeImportBatch,
  findImportBatchByIdempotencyKey,
  getImportBatch,
  getSourceRows,
  insertImportBatch,
  insertReviewEntries,
  insertReviewSnapshot,
  insertRowIssues,
  insertSourceRows,
  listImportBatches,
  MAX_ROWS_PER_INSERT,
  summarizeReviewSnapshot,
  summarizeUrlGroups,
  type BatchCompletion,
  type ImportBatchRecord,
  type IssueCodeCount,
  type NewImportBatch,
  type NewReviewEntry,
  type NewReviewSnapshot,
  type NewRowIssue,
  type NewSourceRow,
  type ReviewSnapshotSummary,
  type ReviewStateCount,
  type SourceRowCounts,
  type StoredSourceRow,
  type UrlGroupStats,
} from './ingestion.js';
export {
  loadMigrations,
  MIGRATIONS_DIRECTORY,
  migrationStatus,
  runMigrations,
  type AppliedMigration,
  type MigrationDrift,
  type MigrationFile,
  type MigrationRunResult,
  type MigrationStatus,
} from './migrate.js';
export { connectionSecrets, createRedactor, REDACTED, type Redactor } from './redact.js';
export { createSchema, dropSchema, listTables, quoteIdentifier } from './schema.js';
