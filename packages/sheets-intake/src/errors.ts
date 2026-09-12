/**
 * Failure kinds this connector distinguishes.
 *
 * Every failure is explicit and carries a fixed message. Nothing here returns
 * an empty success, falls back to cached data, or degrades a refusal into a
 * warning (docs/SECURITY.md section 7).
 *
 * `details` may hold counts, bounds, sanitized tab names, header positions and
 * fixed reason codes. It may never hold a credential, a token, a spreadsheet
 * identifier, a spreadsheet URL, a cell value or a provider response body.
 */
export const SHEETS_FAILURE_KINDS = [
  /** Configuration is absent, malformed, or names an unauthorized workbook. */
  'configuration',
  /** Credentials are missing, unreadable or structurally invalid. */
  'credential',
  /** The authorization exchange failed. */
  'authorization',
  /** A transport-level failure: refused connection, reset, DNS. */
  'network',
  /** The request exceeded its deadline or was cancelled. */
  'timeout',
  /** The API answered with a non-success status. */
  'http',
  /** The response did not match the shape this connector accepts. */
  'schema',
  /** The workbook's structure violated a declared bound or invariant. */
  'structural',
  /** A policy boundary was crossed: wrong origin, wrong scope, wrong workbook. */
  'policy',
] as const;
export type SheetsFailureKind = (typeof SHEETS_FAILURE_KINDS)[number];

/** Values permitted inside `details`. Deliberately narrow. */
export type SafeDetail = string | number | boolean | null | readonly (string | number)[];

export class SheetsIntakeError extends Error {
  readonly kind: SheetsFailureKind;
  readonly code: string;
  readonly details: Readonly<Record<string, SafeDetail>>;

  constructor(
    kind: SheetsFailureKind,
    code: string,
    message: string,
    details: Record<string, SafeDetail> = {},
  ) {
    super(message);
    this.name = 'SheetsIntakeError';
    this.kind = kind;
    this.code = code;
    this.details = details;
  }
}

export function isSheetsIntakeError(value: unknown): value is SheetsIntakeError {
  return value instanceof SheetsIntakeError;
}

/** Shorthand constructors, so a call site never picks a kind by hand. */
export const fail = {
  configuration: (code: string, message: string, details?: Record<string, SafeDetail>) =>
    new SheetsIntakeError('configuration', code, message, details),
  credential: (code: string, message: string, details?: Record<string, SafeDetail>) =>
    new SheetsIntakeError('credential', code, message, details),
  authorization: (code: string, message: string, details?: Record<string, SafeDetail>) =>
    new SheetsIntakeError('authorization', code, message, details),
  network: (code: string, message: string, details?: Record<string, SafeDetail>) =>
    new SheetsIntakeError('network', code, message, details),
  timeout: (code: string, message: string, details?: Record<string, SafeDetail>) =>
    new SheetsIntakeError('timeout', code, message, details),
  http: (code: string, message: string, details?: Record<string, SafeDetail>) =>
    new SheetsIntakeError('http', code, message, details),
  schema: (code: string, message: string, details?: Record<string, SafeDetail>) =>
    new SheetsIntakeError('schema', code, message, details),
  structural: (code: string, message: string, details?: Record<string, SafeDetail>) =>
    new SheetsIntakeError('structural', code, message, details),
  policy: (code: string, message: string, details?: Record<string, SafeDetail>) =>
    new SheetsIntakeError('policy', code, message, details),
} as const;
