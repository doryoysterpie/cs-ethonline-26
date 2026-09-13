import { classifyDriverError } from '@cas/database';
import { describe, expect, it } from 'vitest';

import { toToolError } from './safety/errors.js';
import type { IncidentReadStoreProvider } from './store/read-store.js';
import type { PrivilegeReport } from './store/privileges.js';
import { connectInMemory, SECRET_API_KEY, SECRET_DATABASE_URL, textOf } from './test-support.js';

/**
 * System connection failures and SQLSTATE provenance at the public boundary
 * (Track D re-audit finding M2).
 *
 * A POSIX errno means the socket never carried a statement, so the outcome is
 * an unavailable database, and the errno is never published in the `sqlstate`
 * field — `EPERM` is five uppercase characters and would pass a shape test on
 * its own.
 */

const HOST = '10.0.0.9:5432';

function driverError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/** The five newly classified codes, and the ones that were already connection failures. */
const SYSTEM_CODES = [
  'EPERM',
  'EACCES',
  'ENETDOWN',
  'ECONNABORTED',
  'EADDRNOTAVAIL',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ENOENT',
] as const;

/** A provider whose every read fails the way a refused socket does. */
class RefusingProvider implements IncidentReadStoreProvider {
  readonly #code: string;
  constructor(code: string) {
    this.#code = code;
  }
  withReadTransaction<T>(): Promise<T> {
    return Promise.reject(
      classifyDriverError(driverError(this.#code, `connect ${this.#code} ${HOST}`)),
    );
  }
  verifyPrivileges(): Promise<PrivilegeReport> {
    return Promise.reject(
      classifyDriverError(driverError(this.#code, `connect ${this.#code} ${HOST}`)),
    );
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe('a system connection error is an unavailable database, not a failed query', () => {
  it('maps every system code to database_unavailable with no sqlstate detail', () => {
    for (const code of SYSTEM_CODES) {
      const error = toToolError(classifyDriverError(driverError(code, `connect ${code} ${HOST}`)));
      expect(error.code, code).toBe('database_unavailable');
      expect(error.details, code).toEqual({});
      expect(JSON.stringify(error.details), code).not.toContain(code);
    }
  });

  it('keeps publishing a real SQLSTATE where the contract exposes one', () => {
    for (const [code, expected] of [
      ['28P01', 'database_unavailable'],
      ['3D000', 'database_unavailable'],
      ['08006', 'database_unavailable'],
      ['57014', 'tool_timeout'],
      ['40001', 'database_query_failed'],
      ['23505', 'database_query_failed'],
      ['42501', 'database_query_failed'],
    ] as const) {
      const error = toToolError(classifyDriverError(driverError(code, 'server said so')));
      expect(error.code, code).toBe(expected);
      expect(error.details['sqlstate'], code).toBe(code);
    }
  });

  it('publishes an arbitrary five-character uppercase code, which PostgreSQL may legally raise', () => {
    for (const code of ['ABCDE', 'XYZZY', 'P0001']) {
      const error = toToolError(classifyDriverError(driverError(code, 'user-defined condition')));
      expect(error.details['sqlstate'], code).toBe(code);
    }
  });

  it('refuses an errno in the sqlstate field even if the database layer mislabels one', () => {
    // Defence in depth: the boundary does not trust the store's own source.
    const mislabelled = classifyDriverError(driverError('23505', 'duplicate key'));
    Object.defineProperty(mislabelled, 'code', { value: 'EPERM' });
    expect(toToolError(mislabelled).details['sqlstate']).toBeUndefined();
  });

  it('classifies a system code identically on any Error subclass', () => {
    const typed = new RangeError('connect EPERM') as RangeError & { code: string };
    typed.code = 'EPERM';
    expect(toToolError(classifyDriverError(typed)).code).toBe('database_unavailable');
  });
});

describe('the tool boundary reports a refused socket as an unavailable database', () => {
  it('answers database_unavailable, names no errno as a SQLSTATE and leaks no credential', async () => {
    for (const code of ['EPERM', 'EACCES', 'ECONNREFUSED'] as const) {
      const harness = await connectInMemory({
        store: new RefusingProvider(code),
        env: { DATABASE_URL: SECRET_DATABASE_URL, GRAPH_API_KEY: SECRET_API_KEY },
        live: null,
      });
      try {
        const result = await harness.client.callTool({
          name: 'list_incidents',
          arguments: { evidenceRunId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
        });
        const text = textOf(result);
        expect(result.isError, code).toBe(true);
        expect(text, code).toContain('database_unavailable');
        expect(text, code).not.toContain('database_query_failed');
        expect(text, code).not.toContain('sqlstate');
        expect(text, code).not.toContain(code);
        expect(text, code).not.toContain(HOST);
        expect(text, code).not.toContain(SECRET_API_KEY);
        expect(text, code).not.toContain('seedpassword');
        expect(text, code).not.toContain('postgres://');
      } finally {
        await harness.close();
      }
    }
  });
});
