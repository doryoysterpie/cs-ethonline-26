#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';

import {
  assertRestoreDrillSafety,
  compareTableRowCounts,
  countSchemaRows,
  isDatabaseError,
  migrationStatusForClient,
  openDatabase,
  parseDatabaseConfig,
  parseRestoreDrillTimeout,
} from '../dist/index.js';

const SOURCE_VARIABLE = 'BACKUP_SOURCE_DATABASE_URL';
const TARGET_VARIABLE = 'RESTORE_DATABASE_URL';
const SCHEMA_VARIABLE = 'BACKUP_SOURCE_SCHEMA';

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is not set`);
  }
  return value.trim();
}

function runTool(stage, command, args, environment, timeoutMs, sanitize, captureStdout = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let stdout = '';
    let stdoutOverflow = false;
    let stderr = '';
    if (captureStdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        const available = 1_048_576 - stdout.length;
        if (chunk.length > available) stdoutOverflow = true;
        if (available > 0) stdout += chunk.slice(0, available);
      });
    } else {
      child.stdout.resume();
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    let forceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      reject(new Error(`${stage} failed to start`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (timedOut) reject(new Error(`${stage} timed out`));
      else if (code === 0 && stdoutOverflow) reject(new Error(`${stage} output exceeded 1 MiB`));
      else if (code === 0) resolve(stdout);
      else {
        const detail = sanitize(stderr).trim().replaceAll(/\s+/g, ' ');
        reject(
          new Error(
            `${stage} failed (exit=${code ?? 'none'} signal=${signal ?? 'none'})${detail.length === 0 ? '' : `: ${detail}`}`,
          ),
        );
      }
    });
  });
}

function childEnvironment(connectionString, readOnly) {
  const url = new URL(connectionString);
  const supportedParameters = new Set([
    'application_name',
    'channel_binding',
    'connect_timeout',
    'host',
    'options',
    'ssl',
    'sslcert',
    'sslcrl',
    'sslkey',
    'sslmode',
    'sslrootcert',
    'target_session_attrs',
  ]);
  for (const parameter of url.searchParams.keys()) {
    if (!supportedParameters.has(parameter)) {
      throw new Error('database URL contains an unsupported libpq parameter');
    }
  }
  const decoded = (value, name) => {
    try {
      return decodeURIComponent(value);
    } catch {
      throw new Error(`${name} is not valid percent-encoding`);
    }
  };
  const database = decoded(url.pathname.replace(/^\//, ''), 'database name');
  const host = url.searchParams.get('host') ?? url.hostname;
  const environment = {
    ...process.env,
    PGDATABASE: database,
    PGHOST: decoded(host, 'database host'),
    PGPORT: url.port || '5432',
  };
  delete environment[SOURCE_VARIABLE];
  delete environment[TARGET_VARIABLE];
  if (url.username.length > 0) environment.PGUSER = decoded(url.username, 'database username');
  else delete environment.PGUSER;
  if (url.password.length > 0) environment.PGPASSWORD = decoded(url.password, 'database password');
  else delete environment.PGPASSWORD;
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode !== null) environment.PGSSLMODE = sslmode;
  else if (url.searchParams.get('ssl') === 'true') environment.PGSSLMODE = 'require';
  else delete environment.PGSSLMODE;
  for (const [parameter, variable] of [
    ['application_name', 'PGAPPNAME'],
    ['channel_binding', 'PGCHANNELBINDING'],
    ['connect_timeout', 'PGCONNECT_TIMEOUT'],
    ['sslcert', 'PGSSLCERT'],
    ['sslcrl', 'PGSSLCRL'],
    ['sslkey', 'PGSSLKEY'],
    ['sslrootcert', 'PGSSLROOTCERT'],
    ['target_session_attrs', 'PGTARGETSESSIONATTRS'],
  ]) {
    const value = url.searchParams.get(parameter);
    if (value === null) delete environment[variable];
    else environment[variable] = value;
  }
  if (readOnly) {
    environment.PGOPTIONS = [url.searchParams.get('options'), '-c default_transaction_read_only=on']
      .filter(Boolean)
      .join(' ');
  } else {
    const options = url.searchParams.get('options');
    if (options === null) delete environment.PGOPTIONS;
    else environment.PGOPTIONS = options;
  }
  return environment;
}

function assertCompleteMigrations(label, status) {
  if (status.pending.length !== 0 || status.drift.length !== 0) {
    throw new Error(
      `${label} migration verification failed (applied=${status.applied.length} pending=${status.pending.length} drift=${status.drift.length})`,
    );
  }
}

async function main() {
  const startedAt = Date.now();
  const sourceUrl = required(SOURCE_VARIABLE);
  const targetUrl = required(TARGET_VARIABLE);
  const schema = process.env[SCHEMA_VARIABLE]?.trim() || 'public';
  const timeoutMs = parseRestoreDrillTimeout(process.env.RESTORE_DRILL_TIMEOUT_SECONDS);
  const sourceConfig = parseDatabaseConfig({ DATABASE_URL: sourceUrl }, { schema });
  const targetConfig = parseDatabaseConfig({ DATABASE_URL: targetUrl }, { schema });
  assertRestoreDrillSafety(sourceUrl, targetUrl);

  const source = openDatabase(sourceConfig, { maxConnections: 1 });
  const target = openDatabase(targetConfig, { maxConnections: 1 });
  const sanitize = (value) =>
    target.redact(
      source.redact(
        value.replaceAll(sourceUrl, '[database-url]').replaceAll(targetUrl, '[database-url]'),
      ),
    );
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'cas-restore-drill-'));
  const dumpPath = path.join(temporary, 'backup.dump');
  const restoreListPath = path.join(temporary, 'restore.list');

  try {
    const targetTables = await target.withTransaction((client) => countSchemaRows(client, schema), {
      readOnly: true,
    });
    if (targetTables.length !== 0) {
      throw new Error(
        `restore target rejected: schema is not empty (tables=${targetTables.length})`,
      );
    }

    const sourceEvidence = await source.withTransaction(
      async (client) => {
        const exported = await client.query('SELECT pg_catalog.pg_export_snapshot() AS snapshot');
        const snapshot = exported.rows[0]?.snapshot;
        if (typeof snapshot !== 'string' || snapshot.length === 0) {
          throw new Error('source snapshot export failed');
        }
        const migrations = await migrationStatusForClient(client, schema);
        const counts = await countSchemaRows(client, schema);
        assertCompleteMigrations('source', migrations);
        await runTool(
          'pg_dump',
          'pg_dump',
          [
            '--format=custom',
            '--no-owner',
            '--no-acl',
            `--schema=${schema}`,
            `--snapshot=${snapshot}`,
            `--file=${dumpPath}`,
          ],
          childEnvironment(sourceUrl, true),
          timeoutMs,
          sanitize,
        );
        return { migrations, counts };
      },
      { isolationLevel: 'repeatable read', readOnly: true },
    );

    const restoreArgs = [
      '--dbname=',
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
      '--single-transaction',
    ];
    if (schema === 'public') {
      const list = await runTool(
        'pg_restore list',
        'pg_restore',
        ['--list', dumpPath],
        childEnvironment(targetUrl, false),
        timeoutMs,
        sanitize,
        true,
      );
      const lines = list.split('\n');
      const filtered = lines.filter(
        (line) => !/^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+public(?:\s|$)/.test(line),
      );
      if (filtered.length === lines.length) {
        throw new Error('pg_restore list did not contain the expected public schema entry');
      }
      await writeFile(restoreListPath, filtered.join('\n'), { mode: 0o600 });
      restoreArgs.push(`--use-list=${restoreListPath}`);
    }
    restoreArgs.push(dumpPath);
    await runTool(
      'pg_restore',
      'pg_restore',
      restoreArgs,
      childEnvironment(targetUrl, false),
      timeoutMs,
      sanitize,
    );

    const restoredEvidence = await target.withTransaction(
      async (client) => ({
        migrations: await migrationStatusForClient(client, schema),
        counts: await countSchemaRows(client, schema),
      }),
      { isolationLevel: 'repeatable read', readOnly: true },
    );
    assertCompleteMigrations('restored', restoredEvidence.migrations);
    const differences = compareTableRowCounts(sourceEvidence.counts, restoredEvidence.counts);
    if (differences.length !== 0) {
      throw new Error(
        `restore row-count reconciliation failed (differences=${differences.length})`,
      );
    }

    process.stdout.write(
      `restore_drill: PASS migrations=${restoredEvidence.migrations.applied.length} pending=0 drift=0 tables=${restoredEvidence.counts.length} duration_ms=${Date.now() - startedAt}\n`,
    );
    for (const count of restoredEvidence.counts) {
      process.stdout.write(
        `restore_drill: table=${count.table} source=${count.rows} restored=${count.rows}\n`,
      );
    }
  } finally {
    await source.end();
    await target.end();
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message =
    isDatabaseError(error) || error instanceof Error ? error.message : 'restore drill failed';
  process.stderr.write(`restore_drill: FAIL ${message}\n`);
  process.exitCode = 1;
});
