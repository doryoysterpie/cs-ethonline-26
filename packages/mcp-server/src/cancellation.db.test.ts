import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Database } from '@cas/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STATEMENT_TIMEOUT_MS, STORED_TOOL_DEADLINE_MS } from './bounds.js';
import {
  activeBackends,
  DB_SECRET_API_KEY,
  openTestDatabase,
  seedPipeline,
  type SeededPipeline,
  type TestDatabase,
} from './db-support.js';
import { CallLimiter, invokeTool } from './runtime.js';
import { PostgresReadStoreProvider, textFetchMargin } from './store/postgres-store.js';
import { structured, testRuntime, textOf } from './test-support.js';

/**
 * Genuine cancellation against a real blocked PostgreSQL statement (Track D
 * finding F1), as the provisioned reader role (finding F9). A second
 * connection, the administrator's, holds an access-exclusive lock on
 * `evidence_runs`, so the server's first application read blocks on the
 * server side; the privilege matrix that precedes it reads only the
 * catalogue and is not blocked by that lock.
 *
 * The first group runs the runtime in process with a short deadline, so the
 * deadline path is proven to cancel the backend through `pg_cancel_backend`
 * rather than through the statement timeout.
 *
 * The second group drives the built entry point over stdio, against the same
 * kind of database: `openTestDatabase` creates a database of its own named
 * `cas_mcp_test_<random>`, migrates its public schema (which is what the
 * entry point addresses) and provisions the reader role the child connects
 * as, in the default production mode. Both are dropped afterwards.
 *
 * After every case: no active or queued backend other than the lock holder,
 * no later read, and the four-call capacity fully restored.
 */

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const MARGIN = textFetchMargin([DB_SECRET_API_KEY.length]);

interface LockHolder {
  readonly pid: number;
  release(): Promise<void>;
}

/** Holds `LOCK TABLE evidence_runs IN ACCESS EXCLUSIVE MODE` until released. */
async function holdLock(db: Database): Promise<LockHolder> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pid = 0;
  let finished: Promise<void> = Promise.resolve();
  await new Promise<void>((ready) => {
    finished = db.withTransaction(async (tx) => {
      pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;
      await tx.query('LOCK TABLE evidence_runs IN ACCESS EXCLUSIVE MODE');
      ready();
      await released;
    });
  });
  return {
    pid,
    async release() {
      release();
      await finished;
    },
  };
}

async function waitUntil(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe('the deadline cancels a blocked backend in process, as the reader role', () => {
  let database: TestDatabase;
  let seeded: SeededPipeline;
  let name = '';

  beforeAll(async () => {
    database = await openTestDatabase();
    seeded = await seedPipeline(database.admin);
    name = database.name;
  });

  afterAll(async () => {
    await database?.close();
  });

  function provider(): PostgresReadStoreProvider {
    return new PostgresReadStoreProvider(database.readerConfig, {
      mode: 'production',
      textFetchMargin: MARGIN,
    });
  }

  it('issues pg_cancel_backend at the deadline, before the statement timeout, and unwinds', async () => {
    const store = provider();
    const limiter = new CallLimiter();
    const { runtime, logs } = testRuntime({
      store,
      limiter,
      deadlines: { stored: 1_000, live: 1_000 },
    });
    expect(STATEMENT_TIMEOUT_MS).toBeGreaterThan(1_000);
    const lock = await holdLock(database.admin);
    try {
      const started = Date.now();
      const outcome = await invokeTool(runtime, 'list_incidents', {
        evidenceRunId: seeded.evidenceRunId,
      });
      const elapsed = Date.now() - started;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.code).toBe('tool_timeout');
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(STATEMENT_TIMEOUT_MS);
      // The blocked backend is gone while the lock is still held: cancelled, not timed out.
      expect(
        await waitUntil(
          async () => (await activeBackends(database.admin, name, [lock.pid])).length === 0,
          3_000,
        ),
      ).toBe(true);
      await tick();
      expect(limiter.inFlight).toBe(0);
      expect(runtime.active.size).toBe(0);
      expect(logs.at(-1)).toMatch(/outcome=tool_timeout .*unwound=true/);
    } finally {
      await lock.release();
    }
    // Capacity and the store are intact: the same read now succeeds.
    const after = await invokeTool(runtime, 'list_incidents', {
      evidenceRunId: seeded.evidenceRunId,
    });
    expect(after.ok).toBe(true);
    await runtime.close();
  });

  it('cancels the blocked backend when the client signal aborts, and issues no later read', async () => {
    const store = provider();
    const { runtime } = testRuntime({ store, deadlines: { stored: 60_000, live: 60_000 } });
    const lock = await holdLock(database.admin);
    try {
      const controller = new AbortController();
      const call = invokeTool(
        runtime,
        'explain_incident',
        { evidenceRunId: seeded.evidenceRunId, incidentId: seeded.corroboratedIncidentId },
        { signal: controller.signal },
      );
      expect(
        await waitUntil(
          async () => (await activeBackends(database.admin, name, [lock.pid])).length === 1,
          3_000,
        ),
      ).toBe(true);
      controller.abort();
      const outcome = await call;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.code).toBe('call_cancelled');
      expect(
        await waitUntil(
          async () => (await activeBackends(database.admin, name, [lock.pid])).length === 0,
          3_000,
        ),
      ).toBe(true);
      await tick();
      expect(runtime.active.size).toBe(0);
    } finally {
      await lock.release();
    }
    await runtime.close();
  });
});

describe('cancellation through the built entry point, as the reader role', () => {
  let database: TestDatabase;
  let seeded: SeededPipeline;
  let client: Client;
  let transport: StdioClientTransport;
  const stderr: Buffer[] = [];

  const busy = async (excluded: number[]): Promise<number> =>
    (await activeBackends(database.admin, database.name, excluded)).length;

  beforeAll(async () => {
    database = await openTestDatabase();
    seeded = await seedPipeline(database.admin);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: {
        PATH: process.env['PATH'] ?? '',
        DATABASE_URL: database.readerConfig.connectionString,
      },
      stderr: 'pipe',
    });
    client = new Client(
      { name: 'cancellation-harness', version: '0.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await database?.close();
  });

  it('started in production mode with a verified reader role', () => {
    const log = Buffer.concat(stderr).toString('utf8');
    expect(log).toContain('mode=production database_role=verified');
  });

  it('answers a blocked read with the fixed timeout and leaves no backend behind', async () => {
    const lock = await holdLock(database.admin);
    try {
      const started = Date.now();
      const result = await client.callTool(
        { name: 'list_incidents', arguments: { evidenceRunId: seeded.evidenceRunId } },
        { timeout: STORED_TOOL_DEADLINE_MS + 20_000 },
      );
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^\{"error":\{"code":"tool_timeout"/);
      // Whichever fires first, the statement timeout or the deadline, is a bound the caller can rely on.
      expect(Date.now() - started).toBeGreaterThanOrEqual(
        Math.min(STATEMENT_TIMEOUT_MS, STORED_TOOL_DEADLINE_MS) - 200,
      );
      expect(Date.now() - started).toBeLessThan(STORED_TOOL_DEADLINE_MS + 6_000);
      expect(await waitUntil(async () => (await busy([lock.pid])) === 0, 5_000)).toBe(true);
    } finally {
      await lock.release();
    }
    const log = Buffer.concat(stderr).toString('utf8');
    expect(log).toMatch(/outcome=tool_timeout [^\n]*unwound=true/);
  });

  it('cancels the blocked backend when the client cancels over the protocol', async () => {
    const lock = await holdLock(database.admin);
    try {
      const controller = new AbortController();
      const call = client.callTool(
        {
          name: 'explain_incident',
          arguments: {
            evidenceRunId: seeded.evidenceRunId,
            incidentId: seeded.corroboratedIncidentId,
          },
        },
        { signal: controller.signal, timeout: 60_000 },
      );
      expect(await waitUntil(async () => (await busy([lock.pid])) === 1, 5_000)).toBe(true);
      controller.abort();
      await expect(call).rejects.toThrow();
      // Gone while the lock is still held: the server cancelled it.
      expect(await waitUntil(async () => (await busy([lock.pid])) === 0, 5_000)).toBe(true);
    } finally {
      await lock.release();
    }
    const log = Buffer.concat(stderr).toString('utf8');
    expect(log).toContain('outcome=call_cancelled');
  });

  it('restores the full four-call capacity afterwards', async () => {
    const lock = await holdLock(database.admin);
    let results: Awaited<ReturnType<Client['callTool']>>[];
    try {
      const five = Array.from({ length: 5 }, () =>
        client.callTool(
          { name: 'list_incidents', arguments: { evidenceRunId: seeded.evidenceRunId } },
          { timeout: 60_000 },
        ),
      );
      // Every call opens its own single connection, so all four admitted calls
      // reach the blocked read; the fifth is refused at once by the cap.
      expect(await waitUntil(async () => (await busy([lock.pid])) >= 4, 5_000)).toBe(true);
      await lock.release();
      results = await Promise.all(five);
    } finally {
      await lock.release().catch(() => undefined);
    }
    const codes = results.map((result) => (result.isError === true ? textOf(result) : 'ok'));
    expect(codes.filter((c) => c === 'ok')).toHaveLength(4);
    expect(codes.filter((c) => c.includes('too_many_concurrent_calls'))).toHaveLength(1);
    for (const result of results) {
      if (result.isError !== true) {
        const page = structured(result)['page'] as Record<string, unknown>;
        expect(page['returned']).toBe(seeded.incidentIds.length);
      }
    }
    expect(await busy([])).toBe(0);
  });

  it('aborts and cancels a blocked call when the client disconnects, then exits', async () => {
    const lock = await holdLock(database.admin);
    try {
      void client
        .callTool(
          { name: 'list_incidents', arguments: { evidenceRunId: seeded.evidenceRunId } },
          { timeout: 60_000 },
        )
        .catch(() => undefined);
      expect(await waitUntil(async () => (await busy([lock.pid])) === 1, 5_000)).toBe(true);
      const pid = transport.pid;
      expect(pid).not.toBeNull();
      await client.close();
      // The lock is still held, so only a cancel issued before exit can clear the backend.
      expect(await waitUntil(async () => (await busy([lock.pid])) === 0, 8_000)).toBe(true);
      expect(
        await waitUntil(async () => {
          try {
            process.kill(pid as number, 0);
            return false;
          } catch {
            return true;
          }
        }, 10_000),
      ).toBe(true);
    } finally {
      await lock.release();
    }
    const log = Buffer.concat(stderr).toString('utf8');
    expect(log).toContain('outcome=call_cancelled');
    expect(log).toContain('cas-mcp-server shutdown reason=');
    const shutdownLine = log.split('\n').find((line) => line.includes('shutdown active_calls='));
    if (shutdownLine !== undefined) expect(shutdownLine).toContain('unwound=true');
  });
});
