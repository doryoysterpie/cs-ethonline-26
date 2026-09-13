import { buildRange } from './a1.js';
import type { SheetsReadOnlyClient, TabProperties } from './client.js';
import { safeDisplay } from './display.js';
import { fail } from './errors.js';
import type { SheetsLimits } from './limits.js';
import type { EditorialStage } from './lineage.js';
import { tabDigest } from './schema.js';
import { normalizeCell, serialToInstant, sourceRowKey, type NormalizedCell } from './values.js';

/**
 * The bounded, paginated read.
 *
 * Rows are fetched one explicit A1 range at a time, never "the whole tab", so
 * the memory and the API cost of a read are known before it starts. Each page
 * is checked against the cell bound before it is normalized, and the run is
 * checked against the total-row bound after each page.
 *
 * The property that matters most here is that nothing is ever silently
 * dropped. A tab larger than the bound is a refusal naming the bound and the
 * declared size; it is not a read of the first N rows presented as a read of
 * the tab. A partial reading that looks complete is worse than no reading,
 * because the counts it produces will be believed.
 *
 * Every row carries where it came from — the tab, the one-based row number,
 * the lineage stage the owner assigned that tab, and the instant it was read —
 * and a deterministic key that survives a re-read. Re-reading an unchanged
 * workbook produces the same keys, which is what makes an import idempotent.
 */

export interface TabMapping {
  /** The tab's exact title, as the inventory reported it. */
  readonly title: string;
  /**
   * Which stage of the editorial lineage this tab belongs to. Supplied by the
   * owner after reviewing the inventory. It is never inferred: a wrong stage
   * here is the category error the whole track exists to prevent.
   */
  readonly stage: EditorialStage;
  /** One-based row where data starts. Usually 2, when row 1 is the header. */
  readonly firstDataRow: number;
  /** Columns to read, from column A. Defaults to the declared column count. */
  readonly columns?: number | undefined;
  /** One-based column holding the row's timestamp, when the tab has one. */
  readonly timestampColumn?: number | undefined;
}

export interface SourceRow {
  /** Deterministic identity. Stable across re-reads; never the row number alone. */
  readonly key: string;
  /** Sanitized tab name, safe to display. */
  readonly tabDisplayName: string;
  /** Stable digest of the tab's real name. */
  readonly tabDigest: string;
  readonly stage: EditorialStage;
  /** One-based spreadsheet row. Provenance only. */
  readonly rowNumber: number;
  readonly cells: readonly NormalizedCell[];
  /** Normalized instant from the mapped timestamp column, when there is one. */
  readonly observedAt: string | null;
  /** When this connector read the row. */
  readonly ingestedAt: string;
}

export interface ReadStats {
  readonly tabsRead: number;
  readonly rowsRead: number;
  readonly rowsEmitted: number;
  readonly rowsBlank: number;
  readonly pages: number;
  readonly cellsFormulaLeading: number;
  readonly cellsRequiringEscape: number;
  readonly timestampsNormalized: number;
  readonly timestampsUnreadable: number;
  /** Distinct keys. A smaller number than `rowsEmitted` means duplicate rows. */
  readonly distinctKeys: number;
}

export interface ReadOutcome {
  readonly stats: ReadStats;
  /** Present only when the caller asked to collect rows. */
  readonly rows: readonly SourceRow[];
  readonly warnings: readonly string[];
}

export interface ReadOptions {
  readonly limits: SheetsLimits;
  /** The workbook's declared time zone, for normalizing serial timestamps. */
  readonly timeZone: string | null;
  /** Digest of the workbook identifier. Never the identifier itself. */
  readonly workbookDigest: string;
  /**
   * A dry run reads, validates and counts, and collects nothing. It is the
   * default, so a caller has to ask to hold data in memory.
   */
  readonly collectRows?: boolean | undefined;
  readonly now?: (() => Date) | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Called once per emitted row, for a caller that streams rather than collects. */
  readonly onRow?: ((row: SourceRow) => void) | undefined;
}

function assertWithinRunBound(rowsRead: number, limits: SheetsLimits): void {
  if (rowsRead > limits.maximumRowsPerRun) {
    throw fail.structural(
      'run_row_bound_exceeded',
      'the read exceeded the total row bound for one run and was abandoned rather than truncated',
      { rowsRead, maximum: limits.maximumRowsPerRun },
    );
  }
}

/**
 * Reads one mapped tab, page by page.
 *
 * The declared row count is the allocated grid, which is usually larger than
 * the used range; trailing empty rows are therefore expected and are counted
 * rather than treated as an error. A page that returns fewer rows than asked
 * for means the used range ended, and the read stops there.
 */
export async function readTab(
  client: SheetsReadOnlyClient,
  properties: TabProperties,
  mapping: TabMapping,
  options: ReadOptions,
): Promise<ReadOutcome> {
  const { limits } = options;
  const now = options.now ?? (() => new Date());
  const collect = options.collectRows === true;

  if (properties.sheetType !== 'GRID') {
    throw fail.structural('tab_not_a_grid', 'the mapped tab is not a grid and holds no rows');
  }
  if (properties.rowCount > limits.maximumRowsPerTab) {
    throw fail.structural(
      'tab_row_bound_exceeded',
      'the tab declares more rows than the configured bound permits; no partial read was performed',
      { declaredRows: properties.rowCount, maximum: limits.maximumRowsPerTab },
    );
  }
  const columns = mapping.columns ?? properties.columnCount;
  if (columns > limits.maximumColumnsPerTab) {
    throw fail.structural(
      'tab_column_bound_exceeded',
      'the tab declares more columns than the configured bound permits',
      { declaredColumns: columns, maximum: limits.maximumColumnsPerTab },
    );
  }
  if (columns < 1) {
    throw fail.structural('tab_has_no_columns', 'the mapped tab declares no columns');
  }
  if (!Number.isInteger(mapping.firstDataRow) || mapping.firstDataRow < 1) {
    throw fail.configuration(
      'mapping_first_row_invalid',
      'the mapping names a first data row that is not a positive integer',
    );
  }
  if (
    mapping.timestampColumn !== undefined &&
    (!Number.isInteger(mapping.timestampColumn) ||
      mapping.timestampColumn < 1 ||
      mapping.timestampColumn > columns)
  ) {
    throw fail.configuration(
      'mapping_timestamp_column_invalid',
      'the mapping names a timestamp column outside the columns it reads',
    );
  }

  const perPage = Math.max(1, limits.rowsPerPage);
  if (perPage * columns > limits.maximumCellsPerPage) {
    throw fail.configuration(
      'page_cell_bound_exceeded',
      'the configured page size and column count would exceed the per-page cell bound',
      { rowsPerPage: perPage, columns, maximum: limits.maximumCellsPerPage },
    );
  }

  const display = safeDisplay(properties.title);
  const digest = tabDigest(properties.title);
  const warnings: string[] = [];
  const rows: SourceRow[] = [];
  const keys = new Set<string>();

  let rowsRead = 0;
  let rowsEmitted = 0;
  let rowsBlank = 0;
  let pages = 0;
  let formulaLeading = 0;
  let requiringEscape = 0;
  let normalized = 0;
  let unreadable = 0;

  for (let first = mapping.firstDataRow; first <= properties.rowCount; first += perPage) {
    if (options.signal?.aborted === true) {
      throw fail.timeout('read_cancelled', 'the read was cancelled', { pages, rowsRead });
    }
    const last = Math.min(first + perPage - 1, properties.rowCount);
    const block = await client.values(
      buildRange({ title: properties.title, firstRow: first, lastRow: last, columns }),
    );
    pages += 1;

    for (const [offset, rawRow] of block.values.entries()) {
      const rowNumber = first + offset;
      rowsRead += 1;
      assertWithinRunBound(rowsRead, limits);

      if (rawRow.length > columns) {
        throw fail.structural(
          'row_wider_than_requested',
          'a row returned more columns than the range requested',
          { rowNumber, returned: rawRow.length, requested: columns },
        );
      }
      // Short rows are normal: the API omits trailing empty cells. They are
      // padded so every row in a tab has the same shape.
      const cells: NormalizedCell[] = [];
      for (let column = 0; column < columns; column += 1) {
        const cell = normalizeCell(rawRow[column], limits);
        if (cell.formulaLeading) formulaLeading += 1;
        if (cell.requiresEscaping) requiringEscape += 1;
        cells.push(cell);
      }

      if (cells.every((cell) => cell.kind === 'empty')) {
        rowsBlank += 1;
        continue;
      }

      let observedAt: string | null = null;
      if (mapping.timestampColumn !== undefined) {
        const source = rawRow[mapping.timestampColumn - 1];
        if (source !== undefined && source !== null && source !== '') {
          observedAt = serialToInstant(source, options.timeZone);
          if (observedAt === null) unreadable += 1;
          else normalized += 1;
        }
      }

      const key = sourceRowKey({
        workbookDigest: options.workbookDigest,
        tabDigest: digest,
        rowNumber,
        cells,
      });
      keys.add(key);
      rowsEmitted += 1;

      const row: SourceRow = {
        key,
        tabDisplayName: display,
        tabDigest: digest,
        stage: mapping.stage,
        rowNumber,
        cells,
        observedAt,
        ingestedAt: now().toISOString(),
      };
      options.onRow?.(row);
      if (collect) rows.push(row);
    }

    // Fewer rows than the page asked for means the used range ended here.
    if (block.values.length < last - first + 1) break;
  }

  if (rowsEmitted !== keys.size) {
    // Not an error. Duplicate rows are legitimate in this workbook, and the
    // count is the signal a reviewer needs.
    warnings.push(
      `${rowsEmitted - keys.size} row(s) share an identity with another row of the same tab and position`,
    );
  }
  if (unreadable > 0) {
    warnings.push(`${unreadable} timestamp value(s) could not be normalized and were left absent`);
  }
  if (formulaLeading > 0) {
    warnings.push(
      `${formulaLeading} cell(s) begin like a formula; they are stored as inert text and must be neutralized by any exporter`,
    );
  }

  return {
    stats: {
      tabsRead: 1,
      rowsRead,
      rowsEmitted,
      rowsBlank,
      pages,
      cellsFormulaLeading: formulaLeading,
      cellsRequiringEscape: requiringEscape,
      timestampsNormalized: normalized,
      timestampsUnreadable: unreadable,
      distinctKeys: keys.size,
    },
    rows,
    warnings,
  };
}

/** Sums the statistics of several tab reads into one run total. */
export function totalStats(outcomes: readonly ReadOutcome[]): ReadStats {
  return outcomes.reduce<ReadStats>(
    (total, outcome) => ({
      tabsRead: total.tabsRead + outcome.stats.tabsRead,
      rowsRead: total.rowsRead + outcome.stats.rowsRead,
      rowsEmitted: total.rowsEmitted + outcome.stats.rowsEmitted,
      rowsBlank: total.rowsBlank + outcome.stats.rowsBlank,
      pages: total.pages + outcome.stats.pages,
      cellsFormulaLeading: total.cellsFormulaLeading + outcome.stats.cellsFormulaLeading,
      cellsRequiringEscape: total.cellsRequiringEscape + outcome.stats.cellsRequiringEscape,
      timestampsNormalized: total.timestampsNormalized + outcome.stats.timestampsNormalized,
      timestampsUnreadable: total.timestampsUnreadable + outcome.stats.timestampsUnreadable,
      distinctKeys: total.distinctKeys + outcome.stats.distinctKeys,
    }),
    {
      tabsRead: 0,
      rowsRead: 0,
      rowsEmitted: 0,
      rowsBlank: 0,
      pages: 0,
      cellsFormulaLeading: 0,
      cellsRequiringEscape: 0,
      timestampsNormalized: 0,
      timestampsUnreadable: 0,
      distinctKeys: 0,
    },
  );
}
