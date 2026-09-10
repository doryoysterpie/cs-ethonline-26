import { basename } from 'node:path';
import { parseArgs } from 'node:util';

import type { DataOrigin, EditorialSourceKind } from '@cas/contracts';
import {
  connectionSecrets,
  createRedactor,
  getGraphSignal,
  DATABASE_URL_VARIABLE,
  migrationStatus,
  openDatabase,
  parseDatabaseConfig,
  runMigrations,
  summarizeConnection,
  type Database,
  type DatabaseConfig,
  type Redactor,
} from '@cas/database';

import {
  formatCalibration,
  formatClassificationRun,
  formatQueue,
  formatRunReport,
} from './classification/output.js';
import { calibrateRun, reportRun, reviewQueue } from './classification/report.js';
import { classifyBatch } from './classification/run.js';
import { assertReviewNote } from './clustering/note.js';
import {
  formatClusteringReport,
  formatClusteringRun,
  formatEffectiveView,
  formatReviewAction,
  formatReviewCounts,
} from './clustering/output.js';
import { reportClusteringRun } from './clustering/report.js';
import {
  effectiveIncidents,
  mergeIncidents,
  reviewCounts,
  splitIncident,
  MAX_MERGE_INCIDENTS,
  MAX_SPLIT_MEMBERSHIPS,
} from './clustering/review.js';
import { clusterClassificationRun } from './clustering/run.js';
import { buildAnomalyFeed, formatAnomalyFeed } from './evidence/anomaly.js';
import {
  formatEvidenceReport,
  formatSignalRecord,
  formatSnapshotIngest,
} from './evidence/output.js';
import { decideAssociation, evidenceReviewCounts } from './evidence/review.js';
import { reportEvidenceRun, resolveEvidence } from './evidence/run.js';
import { ingestSnapshot } from './evidence/signals.js';
import { recordIncidentSubject } from './evidence/subject.js';
import { armCommandDeadline, resolveCommandDeadline, type CommandDeadline } from './deadline.js';
import { buildDraftRequest } from './drafting/build.js';
import { writeDraft } from './drafting/generate.js';
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
 *   classification run       --batch UUID
 *   classification report    --run UUID
 *   classification queue     --run UUID
 *   classification calibrate --run UUID
 *   clustering run          --classification-run UUID
 *   clustering report       --run UUID
 *   clustering review-count --run UUID
 *   clustering effective    --run UUID
 *   clustering merge        --run UUID --incidents UUID,UUID --reason CODE
 *   clustering split        --run UUID --incident UUID --members UUID,... --reason CODE
 *
 * Exit codes: 0 success (a completed_with_issues import is a success that
 * retained every row); 2 configuration; 3 structural input; 4 database;
 * 5 unexpected; 124 command deadline expired (`RESOURCE_LIMITS.command`,
 * lowered but never raised by `CAS_COMMAND_DEADLINE_MS`; the command is
 * aborted, its batch rolled back, and the process exits after a grace
 * period); 130 interrupted. Output carries only basenames and labels
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
  /**
   * How a database handle is opened. Defaults to the real driver.
   *
   * The only supported non-default use is a test that must exercise the
   * connection-failure boundary. Sprint 4's own attempt at that pointed a
   * connection string at a closed loopback port, which made the default suite
   * depend on a socket and fail wherever sockets are denied (audit finding
   * F5). Injecting the failure keeps the real `Database`, the real error
   * classification and the real redaction in the path and removes the socket.
   */
  readonly openDatabase?: ((config: DatabaseConfig) => Database) | undefined;
}

const USAGE = [
  'usage:',
  '  db migrate',
  '  db check',
  '  editorial validate --file <path> --kind <master|weekly>',
  '  editorial import --file <path> --kind <master|weekly> --origin <live|fixture|replay> [--review-label <label>]',
  '  editorial report [--batch <id>]',
  '  classification run --batch <uuid>',
  '  classification report --run <uuid>',
  '  classification queue --run <uuid>',
  '  classification calibrate --run <uuid>',
  '  clustering run --classification-run <uuid>',
  '  clustering report --run <uuid>',
  '  clustering review-count --run <uuid>',
  '  clustering effective --run <uuid>',
  '  clustering merge --run <uuid> --incidents <uuid,uuid> --reason <code> [--note <text>]',
  '  clustering split --run <uuid> --incident <uuid> --members <uuid,...> --reason <code> [--note <text>]',
  '  evidence ingest --file <path> --origin <live|fixture|replay>',
  '  evidence subject --run <uuid> --incident <uuid> --chain <ethereum|base> --protocol <slug> --reason <code> [--actor <name>]',
  '  evidence resolve --clustering-run <uuid> --signal-run <uuid>',
  '  evidence report --run <uuid>',
  '  evidence signal --id <uuid>',
  '  evidence review-count --run <uuid>',
  '  evidence decide --run <uuid> --association <uuid> --operation <accept|reject> --relation <supports|conflicts|context> --reason <code> --actor <name> [--claim <uuid>] [--note <text>]',
  '  evidence anomaly --signal-run <uuid> [--as-of <iso>] [--clustering-run <uuid> --window <isoStart..isoEnd> ...]',
  '  drafting generate --evidence-run <uuid> --window <isoStart..isoEnd> [--out <directory>]',
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

/** A classification or clustering command names its subject explicitly; there is no "latest" default. */
function requireUuid(
  value: string | undefined,
  flag: 'batch' | 'run' | 'classification-run' | 'incident',
): string {
  if (value === undefined || value.length === 0) {
    throw configurationError(`${flag}_id_required`, `--${flag} is required`);
  }
  if (!UUID.test(value)) {
    throw configurationError(`${flag}_id_invalid`, `--${flag} must be a UUID`);
  }
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

async function withDatabase<T>(options: CliOptions, fn: (db: Database) => Promise<T>): Promise<T> {
  const open = options.openDatabase ?? openDatabase;
  const db = open(parseDatabaseConfig(options.env));
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
      const result = await withDatabase(options, (db) => runMigrations(db));
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
      const status = await withDatabase(options, async (db) => ({
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
      const outcome = await withDatabase(options, (db) =>
        importCsvFile(db, request, { signal: options.signal }),
      );
      for (const line of formatImportOutcome(outcome, redact)) emit(line);
      return EXIT_CODES.ok;
    }
    if (group === 'editorial' && command === 'report') {
      const batchId = parseBatchId(values.batch);
      const reports = await withDatabase(options, (db) => reportBatches(db, batchId));
      emit(`editorial:report: batches=${reports.length}`);
      for (const report of reports)
        for (const line of formatBatchReport(report, redact)) emit(line);
      const unreconciled = reports.filter((r) => !r.reconciled).length;
      if (unreconciled > 0) emit(`RECONCILIATION FAILED for ${unreconciled} batch(es)`);
      return unreconciled === 0 ? EXIT_CODES.ok : EXIT_CODES.database;
    }
    if (group === 'classification' && command === 'run') {
      const batchId = requireUuid(values.batch, 'batch');
      parseDatabaseConfig(options.env);
      const outcome = await withDatabase(options, (db) => classifyBatch(db, { batchId }));
      for (const line of formatClassificationRun(outcome, redact)) emit(line);
      return EXIT_CODES.ok;
    }
    if (group === 'classification' && command === 'report') {
      const runId = requireUuid(values.run, 'run');
      const report = await withDatabase(options, (db) => reportRun(db, runId));
      for (const line of formatRunReport(report, redact)) emit(line);
      return report.reconciled ? EXIT_CODES.ok : EXIT_CODES.database;
    }
    if (group === 'classification' && command === 'queue') {
      const runId = requireUuid(values.run, 'run');
      const summary = await withDatabase(options, (db) => reviewQueue(db, runId));
      for (const line of formatQueue(summary, redact)) emit(line);
      return EXIT_CODES.ok;
    }
    if (group === 'classification' && command === 'calibrate') {
      const runId = requireUuid(values.run, 'run');
      const report = await withDatabase(options, (db) => calibrateRun(db, runId));
      for (const line of formatCalibration(report, redact)) emit(line);
      return EXIT_CODES.ok;
    }
    if (group === 'clustering' && command === 'run') {
      const classificationRunId = requireUuid(values['classification-run'], 'classification-run');
      const outcome = await withDatabase(options, (db) =>
        clusterClassificationRun(db, { classificationRunId }),
      );
      for (const line of formatClusteringRun(outcome, redact)) emit(line);
      return EXIT_CODES.ok;
    }
    if (group === 'clustering' && command === 'report') {
      const runId = requireUuid(values.run, 'run');
      const report = await withDatabase(options, (db) => reportClusteringRun(db, runId));
      for (const line of formatClusteringReport(report, redact)) emit(line);
      return EXIT_CODES.ok;
    }
    if (group === 'clustering' && command === 'review-count') {
      const runId = requireUuid(values.run, 'run');
      const counts = await withDatabase(options, (db) => reviewCounts(db, runId));
      for (const line of formatReviewCounts(counts, redact)) emit(line);
      return EXIT_CODES.ok;
    }
    if (group === 'clustering' && command === 'effective') {
      const runId = requireUuid(values.run, 'run');
      const view = await withDatabase(options, (db) => effectiveIncidents(db, runId));
      for (const line of formatEffectiveView(view, redact)) emit(line);
      return EXIT_CODES.ok;
    }
    if (group === 'clustering' && command === 'merge') {
      // Every value is validated before a database handle is opened, as the
      // ids and labels of the earlier commands are.
      const runId = requireUuid(values.run, 'run');
      const incidentIds = parseIdList(values.incidents, 'incidents', MAX_MERGE_INCIDENTS);
      const reasonCode = parseReasonCode(values.reason);
      const actor = parseActor(values.actor);
      const note = parseNote(values.note);
      const outcome = await withDatabase(options, (db) =>
        mergeIncidents(db, { runId, incidentIds, reasonCode, actor, note }),
      );
      for (const line of formatReviewAction(outcome, redact)) emit(line);
      return EXIT_CODES.ok;
    }
    if (group === 'evidence' && command === 'ingest') {
      const file = requireFile(values.file);
      const origin = parseOrigin(values.origin);
      const outcome = await withDatabase(options, (db) =>
        ingestSnapshot(db, { snapshotPath: file, dataOrigin: origin }),
      );
      for (const line of formatSnapshotIngest(outcome, redact)) emit(line);
      return EXIT_CODES.ok;
    }
    if (group === 'evidence' && command === 'subject') {
      const clusteringRunId = requireUuid(values.run, 'run');
      const incidentId = requireUuid(values.incident, 'run');
      const chain = parseChain(values.chain);
      const protocolSlug = parseProtocolSlug(values.protocol);
      const reasonCode = parseReasonCode(values.reason);
      const actor = parseActor(values.actor);
      const outcome = await withDatabase(options, (db) =>
        recordIncidentSubject(db, {
          clusteringRunId,
          incidentId,
          chain,
          protocolSlug,
          actor,
          reasonCode,
        }),
      );
      emit(
        `evidence:subject: ${outcome.outcome === 'recorded' ? 'recorded' : 'already recorded'}` +
          ` incident=${outcome.subject.incidentClusterId} chain=${outcome.subject.chain}` +
          ` protocol=${outcome.subject.protocolSlug}`,
      );
      return EXIT_CODES.ok;
    }
    if (group === 'evidence' && command === 'resolve') {
      const clusteringRunId = requireUuid(values['classification-run'] ?? values.run, 'run');
      const signalRunId = requireUuid(values['signal-run'], 'run');
      const outcome = await withDatabase(options, (db) =>
        resolveEvidence(db, { clusteringRunId, signalRunId }),
      );
      const report = await withDatabase(options, (db) => reportEvidenceRun(db, outcome.run.id));
      emit(
        `evidence:resolve: ${outcome.outcome === 'resolved' ? 'resolved' : 'already resolved'} run=${outcome.run.id} suggestions=${outcome.suggestions} unlinkedPairs=${outcome.rejectedPairs}`,
      );
      for (const line of formatEvidenceReport(report, redact)) emit(line);
      return report.reconciled ? EXIT_CODES.ok : EXIT_CODES.database;
    }
    if (group === 'evidence' && command === 'report') {
      const runId = requireUuid(values.run, 'run');
      const report = await withDatabase(options, (db) => reportEvidenceRun(db, runId));
      for (const line of formatEvidenceReport(report, redact)) emit(line);
      return report.reconciled ? EXIT_CODES.ok : EXIT_CODES.database;
    }
    if (group === 'evidence' && command === 'signal') {
      const signalId = requireUuid(values.id, 'run');
      const signal = await withDatabase(options, (db) =>
        db.withClient((client) => getGraphSignal(client, signalId)),
      );
      if (signal === null) {
        throw configurationError('signal_not_found', 'no signal with that id');
      }
      for (const line of formatSignalRecord(signal, redact)) emit(line);
      return EXIT_CODES.ok;
    }
    if (group === 'evidence' && command === 'review-count') {
      const runId = requireUuid(values.run, 'run');
      const counts = await withDatabase(options, (db) => evidenceReviewCounts(db, runId));
      emit(
        `evidence:review-count: run=${runId} actions=${counts.actions} accepted=${counts.accepted} rejected=${counts.rejected} revision=${counts.revision}`,
      );
      return EXIT_CODES.ok;
    }
    if (group === 'evidence' && command === 'decide') {
      // Every value is validated before a database handle is opened.
      const runId = requireUuid(values.run, 'run');
      const associationId = requireUuid(values.association, 'run');
      const operation = parseOperation(values.operation);
      const relation = parseRelation(values.relation);
      const reasonCode = parseReasonCode(values.reason);
      const actor = parseActor(values.actor);
      const note = parseNote(values.note);
      const claimId = values.claim === undefined ? null : requireUuid(values.claim, 'run');
      const outcome = await withDatabase(options, (db) =>
        decideAssociation(db, {
          runId,
          associationId,
          operation,
          relation,
          claimId,
          reasonCode,
          actor,
          rationale: note,
        }),
      );
      emit(
        `evidence:decide: ${outcome.outcome === 'recorded' ? 'recorded' : 'already recorded'} action=${outcome.action.id} revision=${outcome.revision}`,
      );
      return EXIT_CODES.ok;
    }
    if (group === 'evidence' && command === 'anomaly') {
      const signalRunId = requireUuid(values['signal-run'], 'run');
      const clusteringRunId = values.run === undefined ? undefined : requireUuid(values.run, 'run');
      const windows = parseWindows(values.window);
      // Replaying a dated fixture against the wall clock would call every
      // observation stale, which is true of the clock and useless as a
      // demonstration. The as-of instant is explicit and never defaulted to a
      // fixture's own dates, so a live run cannot silently acquire one.
      const asOf = parseInstant(values['as-of']);
      const feed = await withDatabase(options, (db) =>
        buildAnomalyFeed(db, {
          signalRunId,
          ...(clusteringRunId === undefined ? {} : { clusteringRunId }),
          ...(windows === undefined ? {} : { windows }),
          ...(asOf === undefined ? {} : { now: () => asOf }),
        }),
      );
      for (const line of formatAnomalyFeed(feed, redact)) emit(line);
      return EXIT_CODES.ok;
    }
    if (group === 'drafting' && command === 'generate') {
      const evidenceRunId = requireUuid(values['evidence-run'], 'run');
      const windows = parseWindows(values.window);
      const first = windows?.[0];
      if (first === undefined) {
        throw configurationError(
          'windows_required',
          '--window is required as <isoStart>..<isoEnd>; no editorial week is inferred',
        );
      }
      const directory = values.out ?? 'output/drafts';
      const request = await withDatabase(options, (db) =>
        buildDraftRequest(db, {
          evidenceRunId,
          periodStart: first.startsAt,
          periodEnd: first.endsAt,
        }),
      );
      const written = await writeDraft(request, directory);
      emit(
        `drafting:generate: draft=${request.draftId} evidenceRun=${evidenceRunId} origin=${request.dataOrigin} status=unpublished_requires_human_review`,
      );
      emit(
        `counts: incidents=${written.draft.provenance.counts.incidents} claimsWritten=${written.claimsWritten} claimsOmitted=${written.claimsOmitted} namesWithheld=${written.namesWithheld} crypto=${written.draft.provenance.counts.cryptoIncidents}`,
      );
      emit(`files: draft=${basename(written.draftPath)} sidecar=${basename(written.sidecarPath)}`);
      return EXIT_CODES.ok;
    }
    if (group === 'clustering' && command === 'split') {
      const runId = requireUuid(values.run, 'run');
      const incidentId = requireUuid(values.incident, 'incident');
      const membershipIds = parseIdList(values.members, 'members', MAX_SPLIT_MEMBERSHIPS);
      const reasonCode = parseReasonCode(values.reason);
      const actor = parseActor(values.actor);
      const note = parseNote(values.note);
      const outcome = await withDatabase(options, (db) =>
        splitIncident(db, { runId, incidentId, membershipIds, reasonCode, actor, note }),
      );
      for (const line of formatReviewAction(outcome, redact)) emit(line);
      return EXIT_CODES.ok;
    }
    for (const line of USAGE) emitError(line);
    return fail(configurationError('command_unknown', 'unknown command'));
  } catch (error) {
    return fail(error);
  }
}

const REASON_CODE = /^[a-z][a-z0-9_]{2,63}$/;
const ACTOR = /^[a-z][a-z0-9_.:-]{1,63}$/;

/**
 * A bounded comma-separated identifier list. Every element is validated as a
 * UUID before any database access, and the count is bounded so a review
 * command cannot become a bulk edit.
 */
function parseIdList(value: string | undefined, flag: string, maximum: number): string[] {
  if (value === undefined || value.length === 0) {
    throw configurationError(`${flag}_required`, `--${flag} is required`);
  }
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length > maximum) {
    throw configurationError(`${flag}_too_many`, `--${flag} names more ids than permitted`);
  }
  for (const part of parts) {
    if (!UUID.test(part)) {
      throw configurationError(`${flag}_invalid`, `--${flag} must be a comma-separated UUID list`);
    }
  }
  return parts.map((part) => part.toLowerCase());
}

/** Fixed vocabulary chosen by the reviewer, never free-form source text. */
function parseReasonCode(value: string | undefined): string {
  if (value === undefined || !REASON_CODE.test(value)) {
    throw configurationError('reason_invalid', '--reason must be a short lower-case code');
  }
  return value;
}

function parseOperation(value: string | undefined): 'accept' | 'reject' {
  if (value === 'accept' || value === 'reject') return value;
  throw configurationError('operation_invalid', '--operation must be accept or reject');
}

function parseRelation(value: string | undefined): 'supports' | 'conflicts' | 'context' {
  if (value === 'supports' || value === 'conflicts' || value === 'context') return value;
  throw configurationError('relation_invalid', '--relation must be supports, conflicts or context');
}

function parseChain(value: string | undefined): 'ethereum' | 'base' {
  if (value === 'ethereum' || value === 'base') return value;
  throw configurationError('chain_invalid', '--chain must be ethereum or base');
}

/**
 * The provider-returned protocol slug the Sprint 1 identity gate validated.
 * It is compared with a stored signal by equality, so a near miss is a
 * refusal rather than a fuzzy match.
 */
function parseProtocolSlug(value: string | undefined): string {
  if (value === undefined || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) {
    throw configurationError('protocol_invalid', '--protocol must be a lower-case provider slug');
  }
  return value;
}

/** An explicit instant, for replaying dated data against a fixed clock. */
function parseInstant(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw configurationError('instant_invalid', '--as-of must be an ISO 8601 instant');
  }
  return new Date(parsed);
}

/**
 * Explicit window bounds, `<isoStart>..<isoEnd>`, repeatable. No editorial
 * week is inferred here or anywhere: decision D10 has not fixed one.
 */
function parseWindows(
  values: readonly string[] | undefined,
): readonly { readonly startsAt: string; readonly endsAt: string }[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  if (values.length > 64) {
    throw configurationError('windows_invalid', 'too many --window values');
  }
  return values.map((value) => {
    const parts = value.split('..');
    const startsAt = parts[0] ?? '';
    const endsAt = parts[1] ?? '';
    if (
      parts.length !== 2 ||
      Number.isNaN(Date.parse(startsAt)) ||
      Number.isNaN(Date.parse(endsAt))
    ) {
      throw configurationError('windows_invalid', '--window must be <isoStart>..<isoEnd>');
    }
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      throw configurationError('windows_invalid', '--window must end after it starts');
    }
    return { startsAt, endsAt };
  });
}

function parseActor(value: string | undefined): string {
  const actor = value ?? 'owner';
  if (!ACTOR.test(actor)) {
    throw configurationError('actor_invalid', '--actor must be a short lower-case identifier');
  }
  return actor;
}

/**
 * An optional bounded human note. It is stored, never interpreted.
 *
 * The policy is not the command line's own: `assertReviewNote` is the single
 * policy the merge and split worker APIs apply too, and migration 0007 applies
 * the same one in the database. Sprint 4 shipped it here alone, which is
 * exactly how the compiled API came to persist a note carrying a newline.
 */
function parseNote(value: string | undefined): string | null {
  return assertReviewNote(value);
}

const PARSE_OPTIONS = {
  file: { type: 'string' },
  kind: { type: 'string' },
  origin: { type: 'string' },
  'review-label': { type: 'string' },
  batch: { type: 'string' },
  run: { type: 'string' },
  'classification-run': { type: 'string' },
  incidents: { type: 'string' },
  incident: { type: 'string' },
  members: { type: 'string' },
  reason: { type: 'string' },
  note: { type: 'string' },
  actor: { type: 'string' },
  'signal-run': { type: 'string' },
  'as-of': { type: 'string' },
  chain: { type: 'string' },
  protocol: { type: 'string' },
  'evidence-run': { type: 'string' },
  out: { type: 'string' },
  association: { type: 'string' },
  operation: { type: 'string' },
  relation: { type: 'string' },
  claim: { type: 'string' },
  id: { type: 'string' },
  window: { type: 'string', multiple: true },
} as const;

interface ParsedValues {
  readonly file?: string | undefined;
  readonly kind?: string | undefined;
  readonly origin?: string | undefined;
  readonly 'review-label'?: string | undefined;
  readonly 'signal-run'?: string | undefined;
  readonly 'as-of'?: string | undefined;
  readonly chain?: string | undefined;
  readonly protocol?: string | undefined;
  readonly 'evidence-run'?: string | undefined;
  readonly out?: string | undefined;
  readonly association?: string | undefined;
  readonly operation?: string | undefined;
  readonly relation?: string | undefined;
  readonly claim?: string | undefined;
  readonly id?: string | undefined;
  readonly window?: string[] | undefined;
  readonly batch?: string | undefined;
  readonly run?: string | undefined;
  readonly 'classification-run'?: string | undefined;
  readonly incidents?: string | undefined;
  readonly incident?: string | undefined;
  readonly members?: string | undefined;
  readonly reason?: string | undefined;
  readonly note?: string | undefined;
  readonly actor?: string | undefined;
}

export async function main(): Promise<void> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  const redact = baseRedactor(process.env);
  // The deadline is resolved before any command runs, so a malformed
  // CAS_COMMAND_DEADLINE_MS is a configuration error rather than a command
  // that silently runs without one.
  let deadline: CommandDeadline;
  try {
    deadline = resolveCommandDeadline(process.env);
  } catch (error) {
    console.error(formatError(error, redact));
    process.exitCode = exitCodeFor(error);
    return;
  }
  const armed = armCommandDeadline(deadline, {
    onExpire: () => {
      controller.abort();
      console.error(
        toSingleLine(
          redact(
            `error[deadline/command_deadline_expired]: command exceeded its deadline of ${deadline.deadlineMs} ms; work in progress is aborted and rolled back`,
          ),
        ),
      );
    },
    // The grace period lets a cooperative command roll back and return. A
    // command that has not returned by then is ended here; the database rolls
    // back the transaction its dropped connection was inside.
    onGraceExpired: () => process.exit(EXIT_CODES.deadline),
  });
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const code = await run(process.argv.slice(2), {
      env: process.env,
      io: { log: (line) => console.log(line), error: (line) => console.error(line) },
      signal: controller.signal,
    });
    process.exitCode = armed.fired() ? EXIT_CODES.deadline : code;
  } finally {
    armed.disarm();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /[\\/]cli\.js$/.test(process.argv[1]);
if (invokedDirectly) {
  void main();
}
