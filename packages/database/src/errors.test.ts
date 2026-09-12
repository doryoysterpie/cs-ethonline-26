import { describe, expect, it } from 'vitest';

import { classifyDriverError, DatabaseError, isDatabaseError } from './errors.js';

function driverError(code: string, message: string): Error & { code: string; detail?: string } {
  const error = new Error(message) as Error & { code: string; detail?: string };
  error.code = code;
  error.detail = 'Key (canonical_url)=(https://leak.example/marker) already exists.';
  return error;
}

describe('classifyDriverError', () => {
  it('maps socket failures to connection errors and never copies the driver message', () => {
    const error = classifyDriverError(
      driverError('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.9:5432'),
    );
    expect(error.kind).toBe('connection');
    expect(error.code).toBe('ECONNREFUSED');
    expect(error.message).not.toContain('10.0.0.9');
  });

  it('maps SQLSTATE classes to connection, transaction and query kinds', () => {
    expect(
      classifyDriverError(driverError('28P01', 'password authentication failed for user "x"')).kind,
    ).toBe('connection');
    expect(classifyDriverError(driverError('3D000', 'database "x" does not exist')).kind).toBe(
      'connection',
    );
    expect(classifyDriverError(driverError('40001', 'could not serialize')).kind).toBe(
      'transaction',
    );
    const unique = classifyDriverError(driverError('23505', 'duplicate key value'));
    expect(unique.kind).toBe('query');
    expect(unique.code).toBe('23505');
    expect(unique.message).not.toContain('marker');
  });

  it('passes an existing DatabaseError through and handles code-less errors', () => {
    const own = new DatabaseError('drift', 'x');
    expect(classifyDriverError(own)).toBe(own);
    const anonymous = classifyDriverError(new Error('something with a secret marker'));
    expect(isDatabaseError(anonymous)).toBe(true);
    expect(anonymous.message).not.toContain('marker');
  });
});

describe('system error codes are connection failures, never SQLSTATE (re-audit M2)', () => {
  const SYSTEM_CONNECTION_CODES = [
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

  it('classifies every system connection code as a connection failure from the system', () => {
    for (const code of SYSTEM_CONNECTION_CODES) {
      const error = classifyDriverError(driverError(code, `connect ${code} 10.0.0.9:5432`));
      expect(error.kind, code).toBe('connection');
      expect(error.codeSource, code).toBe('system');
      expect(error.code, code).toBe(code);
    }
  });

  it('never writes the word SQLSTATE into a system error message, and copies no driver text', () => {
    for (const code of SYSTEM_CONNECTION_CODES) {
      const error = classifyDriverError(driverError(code, `connect ${code} 10.0.0.9:5432`));
      expect(error.message, code).not.toContain('SQLSTATE');
      expect(error.message, code).not.toContain('10.0.0.9');
      expect(error.message, code).not.toContain('marker');
    }
  });

  it('keeps an unenumerated errno on the system source rather than calling it a SQLSTATE', () => {
    const error = classifyDriverError(driverError('EHOSTDOWN', 'connect EHOSTDOWN'));
    expect(error.codeSource).toBe('system');
    expect(error.message).not.toContain('SQLSTATE');
  });

  it('refuses to attach a code that is neither a SQLSTATE nor an errno', () => {
    const error = classifyDriverError(driverError('ERR_INVALID_ARG_TYPE', 'bad argument'));
    expect(error.code).toBeNull();
    expect(error.codeSource).toBeNull();
    expect(error.message).not.toContain('SQLSTATE');
  });

  it('classifies a system code the same way on any Error subclass', () => {
    const typed = new TypeError('connect EPERM') as TypeError & { code: string };
    typed.code = 'EPERM';
    const error = classifyDriverError(typed);
    expect(error.kind).toBe('connection');
    expect(error.codeSource).toBe('system');
  });

  it('keeps real SQLSTATE values on the sqlstate source', () => {
    for (const [code, kind] of [
      ['28P01', 'connection'],
      ['3D000', 'connection'],
      ['08006', 'connection'],
      ['57014', 'connection'],
      ['40001', 'transaction'],
      ['23505', 'query'],
      ['42501', 'query'],
    ] as const) {
      const error = classifyDriverError(driverError(code, 'server said so'));
      expect(error.kind, code).toBe(kind);
      expect(error.codeSource, code).toBe('sqlstate');
      expect(error.code, code).toBe(code);
    }
  });

  it('treats an arbitrary five-character uppercase code as a SQLSTATE, because PostgreSQL may raise one', () => {
    // `RAISE ... USING ERRCODE = 'ABCDE'` is legal, so a non-standard class is
    // still PostgreSQL's own answer. Only the errno shape is excluded.
    const error = classifyDriverError(driverError('ABCDE', 'user-defined condition'));
    expect(error.codeSource).toBe('sqlstate');
    expect(error.code).toBe('ABCDE');
  });

  it('infers the source when a DatabaseError is built without one', () => {
    expect(new DatabaseError('connection', 'x', { code: 'EPERM' }).codeSource).toBe('system');
    expect(new DatabaseError('query', 'x', { code: '23505' }).codeSource).toBe('sqlstate');
    expect(new DatabaseError('query', 'x').codeSource).toBeNull();
  });
});
