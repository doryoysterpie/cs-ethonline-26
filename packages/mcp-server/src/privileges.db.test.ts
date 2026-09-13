import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { isDatabaseError, openDatabase, quoteIdentifier } from '@cas/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_SECRET_API_KEY,
  openTestDatabase,
  provisionReaderRole,
  seedPipeline,
  SEED_INSTANT,
  type SeededPipeline,
  type TestDatabase,
} from './db-support.js';
import { isToolError } from './safety/errors.js';
import {
  PostgresReadStoreProvider,
  textFetchMargin,
  withReadOnlyConnection,
} from './store/postgres-store.js';
import { PRIVILEGE_CHECKS, verifyDatabasePrivileges } from './store/privileges.js';
import { connectInMemory, structured, textOf } from './test-support.js';

/**
 * Least privilege at the database (F9): the provisioned reader passes every
 * check, the superuser and every widened role fail closed, the read-only
 * transaction and the role's own privileges are two independent refusals,
 * nothing survives a call's connection, and a built-in overloaded in the
 * application schema cannot answer for the catalogue's.
 */

const VERIFY = fileURLToPath(new URL('../dist/verify-role.js', import.meta.url));

async function verifyRoleCommand(
  connectionString: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [VERIFY], {
    env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: connectionString },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  const [code] = (await once(child, 'exit')) as [number | null];
  return {
    code,
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
  };
}

async function readerBackends(database: TestDatabase): Promise<number> {
  return database.admin.withClient(async (client) => {
    const result = await client.query<{ n: string }>(
      `SELECT pg_catalog.count(*)::pg_catalog.text AS n
         FROM pg_catalog.pg_stat_activity WHERE usename = $1`,
      [database.readerRole],
    );
    return Number(result.rows[0]?.n ?? '0');
  });
}

async function eventually(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

describe('F9: the reader role and the privilege matrix', () => {
  let database: TestDatabase;
  let seeded: SeededPipeline;

  beforeAll(async () => {
    database = await openTestDatabase();
    seeded = await seedPipeline(database.admin);
  });

  afterAll(async () => {
    await database?.close();
  });

  it('passes every check as the provisioned reader, on the server path and through the command', async () => {
    const report = await withReadOnlyConnection(database.readerConfig, (client, schema) =>
      verifyDatabasePrivileges(client, schema),
    );
    expect(report.failed).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.code)).toEqual([...PRIVILEGE_CHECKS]);

    const command = await verifyRoleCommand(database.readerConfig.connectionString);
    expect(command.code).toBe(0);
    for (const code of PRIVILEGE_CHECKS) {
      expect(command.stdout).toContain(`cas-mcp-verify-role check=${code} result=pass`);
    }
    expect(command.stdout).toContain('status=verified mode=production failed=0');
    expect(command.stdout + command.stderr).not.toContain(database.readerRole);
    expect(command.stdout + command.stderr).not.toContain('postgres://');
  });

  it('fails the superuser closed: the server refuses to read, and the command exits 1', async () => {
    const report = await withReadOnlyConnection(database.adminConfig, (client, schema) =>
      verifyDatabasePrivileges(client, schema),
    );
    expect(report.ok).toBe(false);
    for (const code of [
      'not_superuser',
      'not_schema_owner',
      'not_relation_owner',
      'no_select_elsewhere',
      'no_table_writes',
      'no_write_capable_membership',
    ] as const) {
      expect(report.failed, code).toContain(code);
    }

    const provider = new PostgresReadStoreProvider(database.adminConfig, {
      mode: 'production',
      textFetchMargin: textFetchMargin([]),
    });
    let reads = 0;
    let failure: unknown;
    try {
      await provider.withReadTransaction(async (store) => {
        reads += 1;
        return store.getEvidenceRun(seeded.evidenceRunId);
      });
    } catch (error) {
      failure = error;
    }
    expect(isToolError(failure) && failure.code).toBe('database_role_overprivileged');
    expect(reads).toBe(0);
    await provider.close();

    const command = await verifyRoleCommand(database.adminConfig.connectionString);
    expect(command.code, command.stdout + command.stderr).toBe(1);
    expect(command.stdout).toContain('check=not_superuser result=fail');
    expect(command.stdout).toMatch(/status=overprivileged mode=production failed=\d+/u);
  });

  it('serves an overprivileged credential only in development mode, and logs it', async () => {
    const provider = new PostgresReadStoreProvider(database.adminConfig, {
      mode: 'development',
      textFetchMargin: textFetchMargin([]),
    });
    const run = await provider.withReadTransaction((store) =>
      store.getEvidenceRun(seeded.evidenceRunId),
    );
    expect(run?.id).toBe(seeded.evidenceRunId);
    await provider.close();
    const harness = await connectInMemory({
      env: { DATABASE_URL: database.adminConfig.connectionString, CAS_MCP_MODE: 'development' },
      store: undefined,
      live: null,
    });
    try {
      expect(harness.runtime.mode).toBe('development');
      expect((await harness.runtime.verifyDatabaseRole()).status).toBe('overprivileged');
      const result = await harness.client.callTool({
        name: 'list_incidents',
        arguments: { evidenceRunId: seeded.evidenceRunId },
      });
      expect(result.isError).not.toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('catches every widening of the reader, and the template converges it back', async () => {
    const reader = quoteIdentifier(database.readerRole);
    const writer = `${database.readerRole}_writer`;
    const verify = async (): Promise<readonly string[]> =>
      (
        await withReadOnlyConnection(database.readerConfig, (client, schema) =>
          verifyDatabasePrivileges(client, schema),
        )
      ).failed;
    const admin = (sql: string): Promise<unknown> =>
      database.admin.withClient((client) => client.query(sql));

    await admin(`GRANT INSERT ON public.import_batches TO ${reader}`);
    expect(await verify()).toContain('no_table_writes');
    await admin(`REVOKE INSERT ON public.import_batches FROM ${reader}`);

    await admin(`GRANT SELECT (id) ON public.import_batches TO ${reader}`);
    expect(await verify()).toContain('no_select_elsewhere');
    await admin(`REVOKE SELECT (id) ON public.import_batches FROM ${reader}`);

    await admin(`GRANT CREATE ON SCHEMA public TO ${reader}`);
    expect(await verify()).toContain('no_schema_create');
    await admin(`REVOKE CREATE ON SCHEMA public FROM ${reader}`);

    await admin(`GRANT TEMP ON DATABASE ${quoteIdentifier(database.name)} TO ${reader}`);
    expect(await verify()).toContain('no_database_temp');
    await admin(`REVOKE TEMP ON DATABASE ${quoteIdentifier(database.name)} FROM ${reader}`);

    // A write-capable role the NOINHERIT reader could SET ROLE to.
    await admin(`CREATE ROLE ${quoteIdentifier(writer)} NOLOGIN`);
    try {
      await admin(`GRANT INSERT ON public.source_rows TO ${quoteIdentifier(writer)}`);
      await admin(`GRANT ${quoteIdentifier(writer)} TO ${reader}`);
      expect(await verify()).toContain('no_write_capable_membership');
      // Rerunning the template revokes the membership and every stray grant.
      await provisionReaderRole(database.admin, database.readerRole, 'public', 'ab'.repeat(24));
      expect(await verify()).toEqual([]);
    } finally {
      await admin(`DROP OWNED BY ${quoteIdentifier(writer)}`);
      await admin(`DROP ROLE IF EXISTS ${quoteIdentifier(writer)}`);
    }
    // The password was replaced by the rerun; restore the harness's own.
    const password = new URL(database.readerConfig.connectionString).password;
    await admin(`ALTER ROLE ${reader} PASSWORD '${password}'`);
    expect(await verify()).toEqual([]);
  });

  it('refuses writes, temporary objects, creation and unrelated tables to the role itself', async () => {
    const plain = openDatabase(database.readerConfig, { maxConnections: 1 });
    const codeOf = async (sql: string): Promise<string | null> => {
      try {
        await plain.withClient((client) => client.query(sql));
        return null;
      } catch (error) {
        return isDatabaseError(error) ? error.code : 'not-a-database-error';
      }
    };
    try {
      expect(
        await codeOf(
          `INSERT INTO public.url_groups (id, canonical_url) VALUES (pg_catalog.gen_random_uuid(), 'x')`,
        ),
      ).toBe('42501');
      expect(await codeOf('CREATE TEMPORARY TABLE scratch (id int)')).toBe('42501');
      expect(await codeOf('CREATE TABLE public.scratch (id int)')).toBe('42501');
      expect(await codeOf('SELECT * FROM public.import_batches')).toBe('42501');
      expect(await codeOf('SELECT * FROM public.schema_migrations')).toBe('42501');
      expect(
        await codeOf('CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'),
      ).toBe('42501');
      expect(await codeOf('SELECT id FROM public.evidence_runs')).toBeNull();
    } finally {
      await plain.end();
    }
  });

  it('lets nothing survive a call: settings, locks and the backend itself are gone', async () => {
    const first = await withReadOnlyConnection(database.readerConfig, async (client) => {
      await client.query(`SET search_path TO pg_temp, public`);
      await client.query(`SET application_name = 'hostile'`);
      await client.query('SELECT pg_catalog.pg_advisory_lock(424242)');
      const pid = await client.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid');
      const path = await client.query<{ p: string }>(
        `SELECT pg_catalog.current_setting('search_path') AS p`,
      );
      return { pid: pid.rows[0]?.pid ?? 0, path: path.rows[0]?.p ?? '' };
    });
    expect(first.path).toBe('pg_temp, public');
    const second = await withReadOnlyConnection(database.readerConfig, async (client) => {
      const pid = await client.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid');
      const settings = await client.query<{ path: string; name: string }>(
        `SELECT pg_catalog.current_setting('search_path') AS path,
                pg_catalog.current_setting('application_name') AS name`,
      );
      return { pid: pid.rows[0]?.pid ?? 0, ...settings.rows[0] };
    });
    expect(second.pid).not.toBe(first.pid);
    expect(second.path).toBe('public,pg_temp');
    expect(second.name).toBe('cas-database');
    const locks = await database.admin.withClient((client) =>
      client.query<{ n: string }>(
        `SELECT pg_catalog.count(*)::pg_catalog.text AS n FROM pg_catalog.pg_locks
          WHERE locktype = 'advisory' AND objid = 424242`,
      ),
    );
    expect(locks.rows[0]?.n).toBe('0');
    expect(
      await eventually(async () => {
        const alive = await database.admin.withClient((client) =>
          client.query<{ n: string }>(
            `SELECT pg_catalog.count(*)::pg_catalog.text AS n FROM pg_catalog.pg_stat_activity WHERE pid = $1`,
            [first.pid],
          ),
        );
        return alive.rows[0]?.n === '0';
      }),
    ).toBe(true);
    expect(await eventually(async () => (await readerBackends(database)) === 0)).toBe(true);
  });

  it('cannot be misled by an application-schema overload of a built-in', async () => {
    // A more specific overload than pg_catalog's to_json(anyelement): resolved
    // unqualified, it wins, and it answers with the wrong instant.
    await database.admin.withClient((client) =>
      client.query(
        `CREATE FUNCTION public.to_json(pg_catalog.timestamptz) RETURNS pg_catalog.json
           LANGUAGE sql IMMUTABLE AS $$ SELECT pg_catalog.to_json('1999-01-01T00:00:00Z'::pg_catalog.timestamptz) $$`,
      ),
    );
    try {
      const shadowed = await database.admin.withClient((client) =>
        client.query<{ v: string }>(`SELECT to_json(now()) #>> '{}' AS v`),
      );
      expect(shadowed.rows[0]?.v).toContain('1999');
      const harness = await connectInMemory({
        env: {
          DATABASE_URL: database.readerConfig.connectionString,
          GRAPH_API_KEY: DB_SECRET_API_KEY,
        },
        store: undefined,
        live: null,
      });
      try {
        const listed = await harness.client.callTool({
          name: 'list_incidents',
          arguments: { evidenceRunId: seeded.evidenceRunId },
        });
        expect(listed.isError, textOf(listed)).not.toBe(true);
        const run = structured(listed)['run'] as Record<string, string>;
        expect(Date.parse(run['completedAt'] ?? '')).toBe(Date.parse(SEED_INSTANT));
        const explained = await harness.client.callTool({
          name: 'explain_incident',
          arguments: {
            evidenceRunId: seeded.evidenceRunId,
            incidentId: seeded.corroboratedIncidentId,
          },
        });
        const sources = structured(explained)['sources'] as Record<string, string>[];
        expect(Date.parse(sources[0]?.['postedAt'] ?? '')).toBe(
          Date.parse('2026-09-04T00:11:07.000Z'),
        );
        const anomalies = await harness.client.callTool({
          name: 'chain_anomalies',
          arguments: {
            mode: 'stored',
            signalRunId: seeded.latestSignalRunId,
            asOf: '2026-09-04T09:11:23Z',
          },
        });
        const boundary = (structured(anomalies)['stored'] as Record<string, unknown>)[
          'boundary'
        ] as Record<string, string>;
        expect(Date.parse(boundary['completedAt'] ?? '')).toBe(
          Date.parse(seeded.signalRunInstants[11] ?? ''),
        );
        expect(textOf(anomalies)).not.toContain('1999');
      } finally {
        await harness.close();
      }
    } finally {
      await database.admin.withClient((client) =>
        client.query('DROP FUNCTION public.to_json(pg_catalog.timestamptz)'),
      );
    }
  });
});
