import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { CsvError, parse } from 'csv-parse';

import { IngestionError, isIngestionError } from './errors.js';

/**
 * Streaming, standards-compliant CSV reading.
 *
 * Bytes are decoded as strict UTF-8 (a malformed sequence rejects the file),
 * a NUL character rejects the file because PostgreSQL text cannot hold it, a
 * leading byte-order mark is consumed and recorded, and csv-parse applies RFC
 * 4180 quoting with embedded newlines, escaped quotes and unlimited field
 * size. Column-count inconsistency and quoting faults are structural
 * failures that reject the whole file. The parser's own error text is never
 * surfaced, because it can quote the offending content; only its error code
 * and line number are.
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
}

const NUL = String.fromCharCode(0);

function createDecoder(stats: {
  byteLength: number;
  bom: boolean;
  hash: ReturnType<typeof createHash>;
}) {
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
        stats.hash.update(chunk);
        stats.byteLength += chunk.length;
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

/** Maps stream, decoder and parser failures to safe `IngestionError`s; application errors pass through. */
export function translateStreamError(error: unknown): unknown {
  if (isIngestionError(error)) return error;
  if (error instanceof CsvError) {
    const code = error.code;
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
 * Reads every record of the file exactly once, delivering the header and then
 * each data row to the handlers in order. Resolves with the byte length,
 * SHA-256 and byte-order-mark flag of the file as read. A handler that throws
 * stops the read; its error is what the caller receives.
 */
export async function readCsv(
  filePath: string,
  handlers: CsvHandlers,
  options: CsvReadOptions = {},
): Promise<CsvStreamStats> {
  const stats = { byteLength: 0, bom: false, hash: createHash('sha256') };
  const decoder = createDecoder(stats);
  const parser = parse({
    bom: true,
    columns: false,
    relax_column_count: false,
    relax_quotes: false,
    skip_empty_lines: false,
    trim: false,
    cast: false,
    max_record_size: 0,
  });
  let pipelineError: unknown = null;
  const done = pipeline(createReadStream(filePath), decoder, parser).catch((error: unknown) => {
    pipelineError = error;
  });

  let header: readonly string[] | null = null;
  let rowNumber = 0;
  try {
    for await (const record of parser as AsyncIterable<string[]>) {
      if (options.signal?.aborted === true) {
        throw new IngestionError('aborted', 'interrupted', 'import interrupted');
      }
      if (header === null) {
        header = record;
        await handlers.onHeader(record);
      } else {
        rowNumber += 1;
        await handlers.onRecord(rowNumber, record);
      }
    }
  } catch (error) {
    // Whatever stopped the loop is the cause: a decoder or parser fault
    // arrives here as the error the parser was destroyed with, and a handler
    // error arrives as itself. The pipeline's own closure error that follows
    // an early exit is only a consequence and is discarded.
    await done;
    throw translateStreamError(error);
  }
  await done;
  if (pipelineError !== null) throw translateStreamError(pipelineError);
  if (header === null) {
    throw new IngestionError('structural', 'header_missing', 'file rejected: no header row');
  }
  return { byteLength: stats.byteLength, sha256: stats.hash.digest('hex'), bom: stats.bom };
}
