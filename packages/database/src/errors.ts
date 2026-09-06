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

/** Only scalar, content-free values may travel in error details. */
export type SafeDetailValue = string | number | boolean | null;

export class DatabaseError extends Error {
  readonly kind: DatabaseFailureKind;
  /** SQLSTATE or system error code when known. Never a copied driver message. */
  readonly code: string | null;
  readonly details: Readonly<Record<string, SafeDetailValue>>;

  constructor(
    kind: DatabaseFailureKind,
    message: string,
    options: { code?: string | null; details?: Record<string, SafeDetailValue> } = {},
  ) {
    super(message);
    this.name = 'DatabaseError';
    this.kind = kind;
    this.code = options.code ?? null;
    this.details = options.details ?? {};
  }
}

export function isDatabaseError(value: unknown): value is DatabaseError {
  return value instanceof DatabaseError;
}

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
 * the error code only. SQLSTATE classes: 08 connection, 28 authentication,
 * 3D unknown database, 40 transaction rollback, 57 operator intervention;
 * everything else is a query failure.
 */
export function classifyDriverError(error: unknown): DatabaseError {
  if (isDatabaseError(error)) return error;
  const code = readCode(error);
  if (code === null) {
    return new DatabaseError('query', 'database operation failed (no error code)');
  }
  if (CONNECTION_SYSTEM_CODES.has(code)) {
    return new DatabaseError('connection', `database unavailable (code ${code})`, { code });
  }
  const sqlClass = code.slice(0, 2);
  if (sqlClass === '08' || sqlClass === '28' || sqlClass === '3D' || sqlClass === '57') {
    return new DatabaseError('connection', `database connection failed (SQLSTATE ${code})`, {
      code,
    });
  }
  if (sqlClass === '40') {
    return new DatabaseError('transaction', `transaction failed (SQLSTATE ${code})`, { code });
  }
  return new DatabaseError('query', `database query failed (SQLSTATE ${code})`, { code });
}
