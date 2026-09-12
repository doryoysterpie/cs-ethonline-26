/**
 * Resource limits.
 *
 * Every bound is declared here rather than at its call site, so the whole
 * resource envelope of the connector can be read in one place and changed in
 * one reviewable commit. A bound that is reached is always an explicit,
 * counted refusal: this connector never silently truncates a workbook, a tab,
 * a row or a cell, because a silent truncation would present partial data as
 * a complete reading.
 *
 * The values are sized for the authorized workbook as the owner describes it:
 * one growing RSS feed tab plus roughly seventy historical weekly tabs.
 */
export interface SheetsLimits {
  /** Tabs one workbook may carry before the inventory refuses it. */
  readonly maximumTabs: number;
  /** Rows one tab may declare, including its header. */
  readonly maximumRowsPerTab: number;
  /** Columns one tab may declare. */
  readonly maximumColumnsPerTab: number;
  /** Characters one cell may carry. */
  readonly maximumCellCharacters: number;
  /** Characters one header cell may carry. */
  readonly maximumHeaderCharacters: number;
  /** Rows requested in one API call. */
  readonly rowsPerPage: number;
  /** Cells one page may return, across all its columns. */
  readonly maximumCellsPerPage: number;
  /** Bytes one API response body may carry. */
  readonly maximumResponseBytes: number;
  /** Total rows one ingestion run may read across all tabs. */
  readonly maximumRowsPerRun: number;
  /** Milliseconds one request may take. */
  readonly requestTimeoutMs: number;
  /** Milliseconds a whole paginated read may take. */
  readonly runTimeoutMs: number;
  /** Attempts for one request, the first included. */
  readonly maximumAttempts: number;
  /** Milliseconds before the first retry; doubled per attempt. */
  readonly retryBaseDelayMs: number;
  /** Ceiling on any single retry delay. */
  readonly retryMaximumDelayMs: number;
}

export const DEFAULT_LIMITS: SheetsLimits = {
  maximumTabs: 200,
  maximumRowsPerTab: 100_000,
  maximumColumnsPerTab: 64,
  maximumCellCharacters: 50_000,
  maximumHeaderCharacters: 200,
  rowsPerPage: 500,
  maximumCellsPerPage: 32_000,
  maximumResponseBytes: 8_388_608,
  maximumRowsPerRun: 250_000,
  requestTimeoutMs: 30_000,
  runTimeoutMs: 900_000,
  maximumAttempts: 4,
  retryBaseDelayMs: 500,
  retryMaximumDelayMs: 8_000,
};

/** Freezes a caller-supplied override onto the defaults. */
export function withLimits(overrides: Partial<SheetsLimits> = {}): SheetsLimits {
  return Object.freeze({ ...DEFAULT_LIMITS, ...overrides });
}
