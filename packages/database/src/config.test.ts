import { describe, expect, it } from 'vitest';

import { assertSchemaName, parseDatabaseConfig, summarizeConnection } from './config.js';
import { isDatabaseError } from './errors.js';

const SECRET_URL = 'postgresql://user:hunter2-marker@db.internal:5432/app';

describe('parseDatabaseConfig', () => {
  it('rejects a missing DATABASE_URL with a configuration error', () => {
    expect(() => parseDatabaseConfig({})).toThrowError(/DATABASE_URL is not set/);
  });

  it('rejects a non-PostgreSQL scheme without echoing the value', () => {
    let caught: unknown;
    try {
      parseDatabaseConfig({ DATABASE_URL: 'mysql://user:hunter2-marker@host/db' });
    } catch (error) {
      caught = error;
    }
    expect(isDatabaseError(caught) && caught.kind === 'configuration').toBe(true);
    expect(String((caught as Error).message)).not.toContain('hunter2-marker');
    expect(String((caught as Error).message)).not.toContain('mysql://');
  });

  it('rejects a value that is not a URL without echoing it', () => {
    expect(() => parseDatabaseConfig({ DATABASE_URL: 'not a url hunter2-marker' })).toThrowError(
      /not a URL$/,
    );
  });

  it('accepts postgres and postgresql schemes and trims whitespace', () => {
    expect(parseDatabaseConfig({ DATABASE_URL: ` ${SECRET_URL} ` }).connectionString).toBe(
      SECRET_URL,
    );
    expect(parseDatabaseConfig({ DATABASE_URL: 'postgres://localhost/db' }).connectionString).toBe(
      'postgres://localhost/db',
    );
  });

  it('validates an optional schema name as a plain identifier', () => {
    expect(
      parseDatabaseConfig({ DATABASE_URL: SECRET_URL }, { schema: 'cas_test_abc' }).schema,
    ).toBe('cas_test_abc');
    expect(() =>
      parseDatabaseConfig({ DATABASE_URL: SECRET_URL }, { schema: 'x"; DROP' }),
    ).toThrow();
    expect(() => assertSchemaName('public')).not.toThrow();
    expect(() => assertSchemaName('Public')).toThrow();
    expect(() => assertSchemaName('a'.repeat(64))).toThrow();
  });
});

describe('summarizeConnection', () => {
  it('classifies loopback TCP, remote TCP and unix sockets without exposing hosts', () => {
    expect(summarizeConnection('postgresql://127.0.0.1:5432/db')).toEqual({
      transport: 'loopback-tcp',
      passwordPresent: false,
      sslRequested: false,
    });
    expect(summarizeConnection(SECRET_URL)).toEqual({
      transport: 'remote-tcp',
      passwordPresent: true,
      sslRequested: false,
    });
    expect(summarizeConnection('postgresql://localhost/db?host=/tmp')).toEqual({
      transport: 'unix-socket',
      passwordPresent: false,
      sslRequested: false,
    });
    expect(summarizeConnection('postgresql://db.internal/db?sslmode=require').sslRequested).toBe(
      true,
    );
  });
});
