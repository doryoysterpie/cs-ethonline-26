import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { RESOURCE_LIMITS, type ImportLimits } from '@cas/contracts';
import { CsvError, parse } from 'csv-parse';

import { IngestionError, isIngestionError } from './errors.js';

/**
 * Streaming, standards-compliant CSV reading.
 *
 * Bytes are decoded as strict UTF-8 (a malformed sequence rejects the file),
 * a NUL character rejects the file because PostgreSQL text cannot hold it, a
 * leading byte-order mark is consumed and recorded, and csv-parse applies RFC
 * 4180 quoting with embedded newlines and escaped quotes. Column-count
 * inconsistency and quoting faults are structural failures that reject the
 * whole file. The parser's own error text is never surfaced, because it can
 * quote the offending content; only its error code and line number are.
 *
 * Resource limits (`RESOURCE_LIMITS.import`, decision D27) are enforced here,
 * while the file is read, so both the validation pass and the import pass
 * inherit them and no caller can reach a row the limits exclude. File bytes
 * are counted chunk by chunk before decoding; the header's column count and
 * every cell's UTF-8 length are checked before the record reaches a handler;
 * the row count and the running total of retained cell bytes are checked as
 * each row arrives; the parser's own record buffer is bounded. A file that
 * crosses any limit is rejected as a whole with a fixed message and numeric
 * details only. Nothing is truncated to fit.
 */

export interface CsvStreamStats {
  readonly byteLength: number;
  readonly sha256: string;
  readonly bom: boolean;
}

export interface CsvHandlers {
  onHeader(cells: readonly string[]): void | Promise<void>;
  /** `rowNumber` is the 1-based logical data row; the header is row 0. */
  onRecord(rowNumber: number, cells: readonly string[]): void | Promise<void>;
}

export interface CsvReadOptions {
  readonly signal?: AbortSignal | undefined;
  /**
   * Test hook only. Production callers take the versioned defaults from
   * `RESOURCE_LIMITS.import`; a test lowers one limit to exercise its
   * boundary without a gigabyte of input.
   */
  readonly limits?: Partial<ImportLimits> | undefined;
}

const NUL = String.fromCharCode(0);

const LIMIT_MESSAGES = {
  limit_file_bytes: 'file rejected: exceeds the import file byte limit',
  limit_column_count: 'file rejected: exceeds the import column count limit',
  limit_cell_bytes: 'file rejected: a cell exceeds the import cell byte limit',
  limit_row_count: 'file rejected: exceeds the import row count limit',
  limit_retained_bytes: 'file rejected: exceeds the import retained byte limit',
  limit_record_bytes: 'file rejected: a record exceeds the import record size limit',
} as const;
export type ImportLimitCode = keyof typeof LIMIT_MESSAGES;
export const IMPORT_LIMIT_CODES = Object.freeze(
  Object.keys(LIMIT_MESSAGES) as readonly ImportLimitCode[],
);

function limitError(code: ImportLimitCode, details: Record<string, number>): IngestionError {
  return new IngestionError('structural', code, LIMIT_MESSAGES[code], details);
}

/** The versioned defaults, with any test override applied and every value checked. */
export function resolveImportLimits(overrides?: Partial<ImportLimits> | undefined): ImportLimits {
  const limits: ImportLimits = { ...RESOURCE_LIMITS.import, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new IngestionError(
        'configuration',
        'import_limit_invalid',
        `import limit ${key} must be a positive integer`,
      );
    }
  }
  return limits;
}

function createDecoder(
  stats: {
    byteLength: number;
    bom: boolean;
    hash: ReturnType<typeof createHash>;
  },
  fileByteLimit: number,
) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let first = true;
  const guard = (text: string): string => {
    if (text.includes(NUL)) {
      throw new IngestionError(
        'structural',
        'unsafe_null_character',
        'file rejected: contains a NUL character',
      );
    }
    return text;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        // Counted before it is hashed or decoded: the limit stops the read at
        // the first chunk that crosses it, not after the file is in memory.
        const total = stats.byteLength + chunk.length;
        if (total > fileByteLimit) {
          throw limitError('limit_file_bytes', { limit: fileByteLimit, observed: total });
        }
        stats.hash.update(chunk);
        stats.byteLength = total;
        if (first) {
          first = false;
          stats.bom =
            chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf;
        }
        callback(null, guard(decoder.decode(chunk, { stream: true })));
      } catch (error) {
        callback(isIngestionError(error) ? error : decodeError());
      }
    },
    flush(callback) {
      try {
        callback(null, guard(decoder.decode()));
      } catch (error) {
        callback(isIngestionError(error) ? error : decodeError());
      }
    },
  });
}

function decodeError(): IngestionError {
  return new IngestionError('structural', 'decode_invalid_utf8', 'file rejected: not valid UTF-8');
}

const CSV_CODES: Readonly<Record<string, string>> = {
  CSV_RECORD_INCONSISTENT_FIELDS_LENGTH: 'csv_inconsistent_columns',
  CSV_RECORD_INCONSISTENT_COLUMNS: 'csv_inconsistent_columns',
  CSV_QUOTE_NOT_CLOSED: 'csv_quote_not_closed',
  CSV_INVALID_CLOSING_QUOTE: 'csv_invalid_closing_quote',
  INVALID_OPENING_QUOTE: 'csv_invalid_opening_quote',
  CSV_INVALID_OPENING_QUOTE: 'csv_invalid_opening_quote',
};

/** The parser's own bound on one record's buffer; mapped to the fixed limit message. */
const CSV_RECORD_SIZE_CODE = 'CSV_MAX_RECORD_SIZE';

function readNumber(error: object, key: string): number | null {
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  }
  return null;
}

/**
 * Maps stream, decoder and parser failures to safe `IngestionError`s;
 * application errors pass through. `recordLimit` is the parser buffer bound
 * in force, reported when the parser refuses an oversized record.
 */
export function translateStreamError(
  error: unknown,
  recordLimit: number = RESOURCE_LIMITS.import.recordBytes,
): unknown {
  if (isIngestionError(error)) return error;
  if (error instanceof CsvError) {
    const code = error.code;
    if (code === CSV_RECORD_SIZE_CODE) {
      return limitError('limit_record_bytes', { limit: recordLimit });
    }
    const mapped = CSV_CODES[code] ?? 'csv_malformed';
    return new IngestionError(
      'structural',
      mapped,
      `file rejected: CSV structure invalid (${code})`,
      { parserCode: code, line: readNumber(error, 'lines'), record: readNumber(error, 'records') },
    );
  }
  const code = readCode(error);
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR' || code === 'EPERM') {
    return new IngestionError('configuration', 'file_unreadable', `file cannot be read (${code})`, {
      systemCode: code,
    });
  }
  if (code === 'ABORT_ERR') {
    return new IngestionError('aborted', 'interrupted', 'import interrupted');
  }
  return error;
}

/**
 * UTF-8 bytes of every cell, summed, after refusing any single cell over the
 * limit. The row number is the only detail: it is a count, never content.
 */
function measureCells(cells: readonly string[], rowNumber: number, cellLimit: number): number {
  let total = 0;
  for (const cell of cells) {
    const bytes = Buffer.byteLength(cell, 'utf8');
    if (bytes > cellLimit) throw limitError('limit_cell_bytes', { limit: cellLimit, rowNumber });
    total += bytes;
  }
  return total;
}

/**
 * Reads every record of the file exactly once, delivering the header and then
 * each data row to the handlers in order. Resolves with the byte length,
 * SHA-256 and byte-order-mark flag of the file as read. A handler that throws
 * stops the read; its error is what the caller receives. A limit that is
 * crossed stops the read before the offending record reaches a handler.
 */
export async function readCsv(
  filePath: string,
  handlers: CsvHandlers,
  options: CsvReadOptions = {},
): Promise<CsvStreamStats> {
  const limits = resolveImportLimits(options.limits);
  const stats = { byteLength: 0, bom: false, hash: createHash('sha256') };
  const decoder = createDecoder(stats, limits.fileBytes);
  const parser = parse({
    bom: true,
    columns: false,
    relax_column_count: false,
    relax_quotes: false,
    skip_empty_lines: false,
    trim: false,
    cast: false,
    max_record_size: limits.recordBytes,
  });
  let pipelineError: unknown = null;
  const done = pipeline(createReadStream(filePath), decoder, parser).catch((error: unknown) => {
    pipelineError = error;
  });

  let header: readonly string[] | null = null;
  let rowNumber = 0;
  let retained = 0;
  try {
    for await (const record of parser as AsyncIterable<string[]>) {
      if (options.signal?.aborted === true) {
        throw new IngestionError('aborted', 'interrupted', 'import interrupted');
      }
      if (header === null) {
        if (record.length > limits.columnCount) {
          throw limitError('limit_column_count', {
            limit: limits.columnCount,
            observed: record.length,
          });
        }
        measureCells(record, 0, limits.cellBytes);
        header = record;
        await handlers.onHeader(record);
      } else {
        if (rowNumber >= limits.rowCount) {
          throw limitError('limit_row_count', { limit: limits.rowCount });
        }
        rowNumber += 1;
        retained += measureCells(record, rowNumber, limits.cellBytes);
        if (retained > limits.retainedBytes) {
          throw limitError('limit_retained_bytes', { limit: limits.retainedBytes, rowNumber });
        }
        await handlers.onRecord(rowNumber, record);
      }
    }
  } catch (error) {
    // Whatever stopped the loop is the cause: a decoder or parser fault
    // arrives here as the error the parser was destroyed with, and a handler
    // error arrives as itself. The pipeline's own closure error that follows
    // an early exit is only a consequence and is discarded.
    await done;
    throw translateStreamError(error, limits.recordBytes);
  }
  await done;
  if (pipelineError !== null) throw translateStreamError(pipelineError, limits.recordBytes);
  if (header === null) {
    throw new IngestionError('structural', 'header_missing', 'file rejected: no header row');
  }
  return { byteLength: stats.byteLength, sha256: stats.hash.digest('hex'), bom: stats.bom };
}
