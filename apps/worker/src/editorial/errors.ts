import { isDatabaseError, type SafeDetailValue } from '@cas/database';

/**
 * Failure kinds of the ingestion path and the documented exit codes. Every
 * message is a fixed string; details hold only counts, row or line numbers,
 * codes and known header names. No source content, path or credential.
 */
export const INGESTION_FAILURE_KINDS = [
  'configuration',
  'structural',
  'database',
  'aborted',
  'unexpected',
] as const;
export type IngestionFailureKind = (typeof INGESTION_FAILURE_KINDS)[number];

export class IngestionError extends Error {
  readonly kind: IngestionFailureKind;
  readonly code: string;
  readonly details: Readonly<Record<string, SafeDetailValue>>;

  constructor(
    kind: IngestionFailureKind,
    code: string,
    message: string,
    details: Record<string, SafeDetailValue> = {},
  ) {
    super(message);
    this.name = 'IngestionError';
    this.kind = kind;
    this.code = code;
    this.details = details;
  }
}

export function isIngestionError(value: unknown): value is IngestionError {
  return value instanceof IngestionError;
}

export const EXIT_CODES = {
  ok: 0,
  configuration: 2,
  structural: 3,
  database: 4,
  unexpected: 5,
  aborted: 130,
} as const;

export function exitCodeFor(error: unknown): number {
  if (isIngestionError(error)) {
    switch (error.kind) {
      case 'configuration':
        return EXIT_CODES.configuration;
      case 'structural':
        return EXIT_CODES.structural;
      case 'database':
        return EXIT_CODES.database;
      case 'aborted':
        return EXIT_CODES.aborted;
      default:
        return EXIT_CODES.unexpected;
    }
  }
  if (isDatabaseError(error)) {
    return error.kind === 'configuration' ? EXIT_CODES.configuration : EXIT_CODES.database;
  }
  return EXIT_CODES.unexpected;
}
