import { parseArgs } from 'node:util';

import type { DataOrigin, EditorialSourceKind } from '@cas/contracts';
import {
  connectionSecrets,
  createRedactor,
  DATABASE_URL_VARIABLE,
  migrationStatus,
  openDatabase,
  parseDatabaseConfig,
  runMigrations,
  summarizeConnection,
  type Database,
  type Redactor,
} from '@cas/database';

import { toSingleLine } from './editorial/display.js';
import { EXIT_CODES, exitCodeFor, IngestionError } from './editorial/errors.js';
import { assertImportRequest, importCsvFile } from './editorial/import.js';
import {
  formatBatchReport,
  formatError,
  formatImportOutcome,
  formatValidation,
} from './editorial/output.js';
import { reportBatches } from './editorial/report.js';
import { validateCsvFile } from './editorial/validate.js';

/**
 * Command-line interface of the Sprint 2 ingestion path.
 *
 *   db migrate                       apply pending migrations; no-op when none
 *   db check                         connectivity, server version, migration status
 *   editorial validate --file F --kind K
 *   editorial import   --file F --kind K --origin O [--review-label L]
 *   editorial report   [--batch ID]
 *
 * Exit codes: 0 success (a completed_with_issues import is a success that
 * retained every row); 2 configuration; 3 structural input; 4 database;
 * 5 unexpected; 130 interrupted. Output carries only basenames and labels
 * rendered as safe single-line text, hashes, counts, ids, statuses,
 * durations, issue codes and fixed messages. Every emitted entry passes
 * through the redactor for the connection string and its password
 * components, then through the single-line guard, so it is exactly one
 * physical line. A configured `DATABASE_URL` is validated in full before any
 * command is dispatched, review labels and batch ids are validated before any
 * file or database access.
 */

export interface CliIo {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

export interface CliOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly io: CliIo;
  readonly signal?: AbortSignal | undefined;
}

const USAGE = [
  'usage:',
  '  db migrate',
  '  db check',
  '  editorial validate --file <path> --kind <master|weekly>',
  '  editorial import --file <path> --kind <master|weekly> --origin <live|fixture|replay> [--review-label <label>]',
  '  editorial report [--batch <id>]',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function configurationError(code: string, message: string): IngestionError {
  return new IngestionError('configuration', code, message);
}

function parseKind(value: string | undefined): EditorialSourceKind {
  if (value === 'master' || value === 'weekly') return value;
  throw configurationError('source_kind_invalid', '--kind must be master or weekly');
}

function parseOrigin(value: string | undefined): DataOrigin {
  if (value === 'live' || value === 'fixture' || value === 'replay') return value;
  throw configurationError(
    'origin_required',
    '--origin must be given explicitly as live, fixture or replay; there is no default',
  );
}

function requireFile(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw configurationError('file_required', '--file is required');
  }
  return value;
}

function parseBatchId(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!UUID.test(value)) throw configurationError('batch_id_invalid', '--batch must be a UUID');
  return value.toLowerCase();
}

/** Covers the whole DATABASE_URL plus its raw and percent-decoded password, when set. */
function baseRedactor(env: Readonly<Record<string, string | undefined>>): Redactor {
  const url = env[DATABASE_URL_VARIABLE];
  return createRedactor(url === undefined ? [] : connectionSecrets(url));
}

/**
 * Validates a configured `DATABASE_URL` in full before any command runs,
 * including validation, which needs no database.
 *
 * An absent or empty value is not a configuration: `editorial validate`
 * keeps working without a database. A non-empty value is validated
 * structurally by `parseDatabaseConfig`, which is the surrounding validator
 * that owns scheme and URL checks, and which applies the credential policy
 * in turn. Checking the credential policy alone here was not enough: it
 * deliberately ignores values whose scheme is not PostgreSQL, so a
 * non-PostgreSQL URL carrying a password too short for the redactor slipped
 * through and could reach the output of a command that never opens a
 * database.
 */
function assertConfiguredDatabaseUrl(env: Readonly<Record<string, string | undefined>>): void {
  const url = env[DATABASE_URL_VARIABLE];
  if (url === undefined || url.trim().length === 0) return;
  parseDatabaseConfig(env);
}

async function withDatabase<T>(
  env: Readonly<Record<string, string | undefined>>,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const db = openDatabase(parseDatabaseConfig(env));
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

export async function run(argv: readonly string[], options: CliOptions): Promise<number> {
  const redact = baseRedactor(options.env);
  const emit = (line: string): void => options.io.log(toSingleLine(redact(line)));
  const emitError = (line: string): void => options.io.error(toSingleLine(redact(line)));
  const fail = (error: unknown): number => {
    emitError(formatError(error, redact));
    return exitCodeFor(error);
  };
  let positionals: string[];
  let values: ParsedValues;
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    positionals = parsed.positionals;
    values = parsed.values;
  } catch {
    for (const line of USAGE) emitError(line);
    return fail(configurationError('arguments_invalid', 'unrecognized or malformed arguments'));
  }
  const [group, command] = positionals;
  try {
    assertConfiguredDatabaseUrl(options.env);
    if (group === 'db' && command === 'migrate') {
      const result = await withDatabase(options.env, (db) => runMigrations(db));
      emit(
        `db:migrate: applied=${result.applied.length} alreadyApplied=${result.alreadyApplied} total=${result.total}${
          result.applied.length === 0 ? ' (no-op)' : ''
        }`,
      );
      for (const name of result.applied) emit(`  applied ${name}`);
      return EXIT_CODES.ok;
    }
    if (group === 'db' && command === 'check') {
      const summary = summarizeConnection(parseDatabaseConfig(options.env).connectionString);
      const status = await withDatabase(options.env, async (db) => ({
        version: await db.serverVersion(),
        migrations: await migrationStatus(db),
      }));
      emit(
        `db:check: connected; serverVersion=${status.version}; transport=${summary.transport}; passwordPresent=${summary.passwordPresent ? 'yes' : 'no'}; ssl=${summary.sslRequested ? 'yes' : 'no'}`,
      );
      emit(
        `migrations: applied=${status.migrations.applied.length} pending=${status.migrations.pending.length} drift=${status.migrations.drift.length}`,
      );
      for (const m of status.migrations.applied)
        emit(`  applied ${m.version} ${m.name} at ${m.appliedAt}`);
      for (const name of status.migrations.pending) emit(`  pending ${name}`);
      for (const d of status.migrations.drift)
        emit(`  DRIFT version=${d.version} reason=${d.reason}`);
      return status.migrations.drift.length === 0 ? EXIT_CODES.ok : EXIT_CODES.database;
    }
    if (group === 'editorial' && command === 'validate') {
      const file = requireFile(values.file);
      const kind = parseKind(values.kind);
      const report = await validateCsvFile(file, kind, { signal: options.signal });
      for (const line of formatValidation(report, redact)) emit(line);
      return EXIT_CODES.ok;
    }
    if (group === 'editorial' && command === 'import') {
      const file = requireFile(values.file);
      const kind = parseKind(values.kind);
      const origin = parseOrigin(values.origin);
      const reviewLabel = values['review-label'] ?? null;
      // Configuration, the review label and the basename are checked before
      // any connection or file read.
      const request = { filePath: file, sourceKind: kind, origin, reviewLabel };
      assertImportRequest(request);
      parseDatabaseConfig(options.env);
      const outcome = await withDatabase(options.env, (db) =>
        importCsvFile(db, request, { signal: options.signal }),
      );
      for (const line of formatImportOutcome(outcome, redact)) emit(line);
      return EXIT_CODES.ok;
    }
    if (group === 'editorial' && command === 'report') {
      const batchId = parseBatchId(values.batch);
      const reports = await withDatabase(options.env, (db) => reportBatches(db, batchId));
      emit(`editorial:report: batches=${reports.length}`);
      for (const report of reports)
        for (const line of formatBatchReport(report, redact)) emit(line);
      const unreconciled = reports.filter((r) => !r.reconciled).length;
      if (unreconciled > 0) emit(`RECONCILIATION FAILED for ${unreconciled} batch(es)`);
      return unreconciled === 0 ? EXIT_CODES.ok : EXIT_CODES.database;
    }
    for (const line of USAGE) emitError(line);
    return fail(configurationError('command_unknown', 'unknown command'));
  } catch (error) {
    return fail(error);
  }
}

const PARSE_OPTIONS = {
  file: { type: 'string' },
  kind: { type: 'string' },
  origin: { type: 'string' },
  'review-label': { type: 'string' },
  batch: { type: 'string' },
} as const;

interface ParsedValues {
  readonly file?: string | undefined;
  readonly kind?: string | undefined;
  readonly origin?: string | undefined;
  readonly 'review-label'?: string | undefined;
  readonly batch?: string | undefined;
}

export async function main(): Promise<void> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const code = await run(process.argv.slice(2), {
      env: process.env,
      io: { log: (line) => console.log(line), error: (line) => console.error(line) },
      signal: controller.signal,
    });
    process.exitCode = code;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /[\\/]cli\.js$/.test(process.argv[1]);
if (invokedDirectly) {
  void main();
}
