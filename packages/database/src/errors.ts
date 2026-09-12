/**
 * Failure kinds the database layer distinguishes. Every failure is explicit
 * (docs/SECURITY.md section 7). Messages are fixed strings chosen by this
 * package; the driver's own message, detail and hint are never copied,
 * because they can contain connection details or row values.
 */
export const DATABASE_FAILURE_KINDS = [
  'configuration',
  'connection',
  'migration',
  'drift',
  'query',
  'transaction',
] as const;
export type DatabaseFailureKind = (typeof DATABASE_FAILURE_KINDS)[number];

/**
 * Where a `DatabaseError`'s code came from. The two are different things and
 * are never interchangeable: a SQLSTATE is PostgreSQL's own five-character
 * answer to a statement, and a system code is a POSIX errno the socket layer
 * produced before any statement ran. Only a `sqlstate` code may be published
 * as one.
 */
export const DATABASE_CODE_SOURCES = ['sqlstate', 'system'] as const;
export type DatabaseCodeSource = (typeof DATABASE_CODE_SOURCES)[number];

/** Only scalar, content-free values may travel in error details. */
export type SafeDetailValue = string | number | boolean | null;

/**
 * POSIX errno shape. No PostgreSQL SQLSTATE class begins with `E` — the
 * classes are 00, 01, 02, 03, 08, 09, 0A, 0B, 0F, 0L, 0P, 0Z, 20 to 2F, 34,
 * 38, 39, 3B, 3D, 3F, 40, 42, 44, 53, 54, 55, 57, 58, 72, F0, HV, P0 and XX —
 * so an `E`-initial code at this boundary is a system error, never a
 * SQLSTATE. Underscores are excluded so a Node `ERR_*` code does not match.
 */
const SYSTEM_ERROR_CODE = /^E[A-Z0-9]+$/;
/** PostgreSQL SQLSTATE: a two-character class followed by a three-character subclass. */
const SQLSTATE_CODE = /^[0-9A-Z]{5}$/;

/**
 * Classifies a code by shape, system-first. This is a fallback for a
 * `DatabaseError` constructed without an explicit source;
 * `classifyDriverError` states the source itself rather than relying on it.
 */
function inferCodeSource(code: string | null): DatabaseCodeSource | null {
  if (code === null) return null;
  if (SYSTEM_ERROR_CODE.test(code)) return 'system';
  if (SQLSTATE_CODE.test(code)) return 'sqlstate';
  return null;
}

export class DatabaseError extends Error {
  readonly kind: DatabaseFailureKind;
  /** SQLSTATE or system error code when known. Never a copied driver message. */
  readonly code: string | null;
  /** Which of the two `code` is, so neither can be reported as the other. */
  readonly codeSource: DatabaseCodeSource | null;
  readonly details: Readonly<Record<string, SafeDetailValue>>;

  constructor(
    kind: DatabaseFailureKind,
    message: string,
    options: {
      code?: string | null;
      codeSource?: DatabaseCodeSource | null;
      details?: Record<string, SafeDetailValue>;
    } = {},
  ) {
    super(message);
    this.name = 'DatabaseError';
    this.kind = kind;
    this.code = options.code ?? null;
    this.codeSource = options.codeSource ?? inferCodeSource(this.code);
    this.details = options.details ?? {};
  }
}

export function isDatabaseError(value: unknown): value is DatabaseError {
  return value instanceof DatabaseError;
}

/**
 * System error codes that mean the connection itself failed: the socket was
 * refused, reset, never resolved, timed out, had no route, or was forbidden
 * before a single statement could run. None of them is the outcome of a
 * query, so none may be reported as one.
 */
const CONNECTION_SYSTEM_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ENOENT',
  // A sandbox, firewall, seccomp profile or socket permission refused the
  // connection before it was made. The database is unreachable from here; no
  // query was sent, so this is availability, not a failed statement.
  'EPERM',
  'EACCES',
  'ENETDOWN',
  'ECONNABORTED',
  'EADDRNOTAVAIL',
]);

function readCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code)) return code;
  }
  return null;
}

/**
 * Maps a driver or socket error to a `DatabaseError` with a fixed message and
 * the error code only. A system errno is a connection failure and is labelled
 * `system`; it is never called a SQLSTATE, in the message or in the source.
 * SQLSTATE classes: 08 connection, 28 authentication, 3D unknown database,
 * 57 operator intervention, 40 transaction rollback; everything else is a
 * query failure.
 */
export function classifyDriverError(error: unknown): DatabaseError {
  if (isDatabaseError(error)) return error;
  const code = readCode(error);
  if (code === null) {
    return new DatabaseError('query', 'database operation failed (no error code)');
  }
  if (CONNECTION_SYSTEM_CODES.has(code)) {
    return new DatabaseError('connection', `database unavailable (code ${code})`, {
      code,
      codeSource: 'system',
    });
  }
  if (SYSTEM_ERROR_CODE.test(code)) {
    // An errno this layer does not enumerate. It still came from the socket,
    // not from a statement, so it keeps the system source and says nothing
    // about SQLSTATE.
    return new DatabaseError('query', `database operation failed (code ${code})`, {
      code,
      codeSource: 'system',
    });
  }
  if (!SQLSTATE_CODE.test(code)) {
    return new DatabaseError('query', 'database operation failed (unrecognized error code)');
  }
  const sqlClass = code.slice(0, 2);
  if (sqlClass === '08' || sqlClass === '28' || sqlClass === '3D' || sqlClass === '57') {
    return new DatabaseError('connection', `database connection failed (SQLSTATE ${code})`, {
      code,
      codeSource: 'sqlstate',
    });
  }
  if (sqlClass === '40') {
    return new DatabaseError('transaction', `transaction failed (SQLSTATE ${code})`, {
      code,
      codeSource: 'sqlstate',
    });
  }
  return new DatabaseError('query', `database query failed (SQLSTATE ${code})`, {
    code,
    codeSource: 'sqlstate',
  });
}
