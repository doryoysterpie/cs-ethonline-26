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
