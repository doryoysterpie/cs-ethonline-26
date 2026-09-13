import { buildRange } from './a1.js';
import type { SheetsReadOnlyClient, TabProperties, WorkbookMetadata } from './client.js';
import { hasControlCharacter, safeDisplay } from './display.js';
import { fail } from './errors.js';
import type { SheetsLimits } from './limits.js';
import { AUTHORIZED_WORKBOOK_TITLE } from './policy.js';
import {
  analyzeHeaders,
  inferTabType,
  tabDigest,
  type HeaderAnalysis,
  type TabInference,
} from './schema.js';
import { serialToInstant } from './values.js';

/**
 * The metadata-only inventory.
 *
 * This is the first thing that runs against the real workbook, and its whole
 * purpose is to let the owner and a reviewer agree on the workbook's structure
 * before anything is imported. It therefore reports structure and refuses to
 * report content.
 *
 * What it reads: the workbook's title and tab properties, and the first row of
 * each tab. What it reports: counts, sanitized tab names, sanitized header
 * names, duplicate and blank header positions, a provisional type guess and
 * any structural warning. What it never reports: a data cell, a URL, a
 * headline, the spreadsheet identifier, or anything derived from them.
 *
 * Reading the header row is a cell read, and it is the one the owner
 * authorized: header names are named in the permitted-output list. No other
 * row is read unless the caller explicitly asks for a timestamp range, which
 * is off by default and reports two instants and a count rather than values.
 *
 * The inventory writes nothing, anywhere. It has no database handle, and the
 * client it holds exposes no method that writes.
 */

export interface TabInventory {
  /** Sanitized tab name. Safe for one line of output. */
  readonly displayName: string;
  /** Stable digest of the original name, for comparing runs. */
  readonly digest: string;
  /** True when the original name carried characters that had to be escaped. */
  readonly nameSanitized: boolean;
  readonly index: number;
  readonly hidden: boolean;
  readonly sheetType: string;
  /** Declared grid size, which is the allocated rectangle, not the used one. */
  readonly declaredRows: number;
  readonly declaredColumns: number;
  readonly frozenRows: number;
  readonly headers: HeaderAnalysis | null;
  readonly inference: TabInference | null;
  /** Structural observations for a human. Never contains cell content. */
  readonly warnings: readonly string[];
}

export interface WorkbookInventory {
  /** True only when the API's title equals the authorized file name exactly. */
  readonly titleMatches: boolean;
  /** The authorized name, echoed so a report is self-describing. */
  readonly expectedTitle: string;
  /** The workbook's locale and time zone, which a timestamp reading depends on. */
  readonly locale: string | null;
  readonly timeZone: string | null;
  readonly tabCount: number;
  readonly visibleTabCount: number;
  readonly hiddenTabCount: number;
  readonly tabs: readonly TabInventory[];
  readonly warnings: readonly string[];
  /** Counted, so a reader knows whether the report is complete. */
  readonly tabsInspected: number;
  readonly tabsSkipped: number;
}

export interface InventoryOptions {
  readonly limits: SheetsLimits;
  /**
   * Reads the first row of each tab to report header names. On by default:
   * header names are within the permitted output and are the main thing a
   * mapping review needs.
   */
  readonly readHeaders?: boolean | undefined;
  /** Inspect at most this many tabs. Absent means every tab. */
  readonly maximumTabs?: number | undefined;
}

function describeTab(properties: TabProperties): {
  displayName: string;
  digest: string;
  nameSanitized: boolean;
} {
  const display = safeDisplay(properties.title);
  return {
    displayName: display,
    digest: tabDigest(properties.title),
    nameSanitized: hasControlCharacter(properties.title) || display !== properties.title,
  };
}

function tabWarnings(properties: TabProperties, limits: SheetsLimits): string[] {
  const warnings: string[] = [];
  if (properties.sheetType !== 'GRID') {
    warnings.push(
      `tab type is ${safeDisplay(properties.sheetType)}, not a grid; no rows are readable`,
    );
  }
  if (properties.rowCount > limits.maximumRowsPerTab) {
    warnings.push(
      `declared row count ${properties.rowCount} exceeds the configured bound ${limits.maximumRowsPerTab}`,
    );
  }
  if (properties.columnCount > limits.maximumColumnsPerTab) {
    warnings.push(
      `declared column count ${properties.columnCount} exceeds the configured bound ${limits.maximumColumnsPerTab}`,
    );
  }
  if (properties.rowCount === 0) warnings.push('tab declares no rows');
  if (properties.frozenRowCount > 1) {
    warnings.push(
      `tab freezes ${properties.frozenRowCount} rows; the header may not be a single row`,
    );
  }
  return warnings;
}

/**
 * Inspects the authorized workbook and returns its structure.
 *
 * Every failure that concerns one tab is captured as a warning on that tab
 * rather than aborting the run, because a partial inventory that says which
 * tabs it could not read is more useful for a mapping review than no
 * inventory at all. A failure that concerns the workbook aborts.
 */
export async function inventoryWorkbook(
  client: SheetsReadOnlyClient,
  options: InventoryOptions,
): Promise<WorkbookInventory> {
  const metadata: WorkbookMetadata = await client.metadata();
  const titleMatches = metadata.title === AUTHORIZED_WORKBOOK_TITLE;
  const warnings: string[] = [];
  if (!titleMatches) {
    // Reported, not thrown: the identifier already passed the pinned-digest
    // check, so a title mismatch means the owner renamed the file or pinned
    // the wrong one. Both are worth a human's attention, and neither is a
    // reason to hide the rest of the structure.
    warnings.push(
      `the workbook title does not match the authorized file name; found ${safeDisplay(metadata.title)}`,
    );
  }
  if (metadata.timeZone === null) {
    warnings.push('the workbook declares no time zone; serial timestamps cannot be normalized');
  }

  const readHeaders = options.readHeaders ?? true;
  const limit = options.maximumTabs ?? metadata.tabs.length;
  const selected = metadata.tabs.slice(0, limit);
  const tabs: TabInventory[] = [];

  for (const properties of selected) {
    const described = describeTab(properties);
    const perTab = tabWarnings(properties, options.limits);
    let headers: HeaderAnalysis | null = null;
    let inference: TabInference | null = null;

    if (readHeaders && properties.sheetType === 'GRID' && properties.rowCount > 0) {
      const columns = Math.min(properties.columnCount, options.limits.maximumColumnsPerTab);
      if (columns === 0) {
        perTab.push('tab declares no columns; no header row was read');
      } else {
        try {
          const range = buildRange({
            title: properties.title,
            firstRow: 1,
            lastRow: 1,
            columns,
          });
          const block = await client.values(range);
          const row = block.values[0] ?? [];
          headers = analyzeHeaders(row, options.limits);
          inference = inferTabType(headers);
          if (headers.blankColumns.length > 0) {
            perTab.push(`blank header cells at columns ${headers.blankColumns.join(', ')}`);
          }
          for (const duplicate of headers.duplicates) {
            perTab.push(
              `duplicate header at columns ${duplicate.columns.join(', ')} (${safeDisplay(duplicate.normalized)})`,
            );
          }
          if (headers.anySanitized) {
            perTab.push(
              'one or more header cells carried characters that were escaped for display',
            );
          }
          if (row.length === 0) perTab.push('the first row is empty; no headers were found');
        } catch (error) {
          // One unreadable tab does not end the inventory.
          perTab.push(
            `the header row could not be read: ${
              error instanceof Error ? safeDisplay(error.message) : 'unknown failure'
            }`,
          );
        }
      }
    }

    tabs.push({
      displayName: described.displayName,
      digest: described.digest,
      nameSanitized: described.nameSanitized,
      index: properties.index,
      hidden: properties.hidden,
      sheetType: properties.sheetType,
      declaredRows: properties.rowCount,
      declaredColumns: properties.columnCount,
      frozenRows: properties.frozenRowCount,
      headers,
      inference,
      warnings: perTab,
    });
  }

  return {
    titleMatches,
    expectedTitle: AUTHORIZED_WORKBOOK_TITLE,
    locale: metadata.locale,
    timeZone: metadata.timeZone,
    tabCount: metadata.tabs.length,
    visibleTabCount: metadata.tabs.filter((tab) => !tab.hidden).length,
    hiddenTabCount: metadata.tabs.filter((tab) => tab.hidden).length,
    tabs,
    warnings,
    tabsInspected: tabs.length,
    tabsSkipped: metadata.tabs.length - tabs.length,
  };
}

export interface TimestampRange {
  readonly tabDisplayName: string;
  readonly column: number;
  /** Earliest normalized instant, or null when none could be read. */
  readonly earliest: string | null;
  readonly latest: string | null;
  readonly readRows: number;
  readonly usableValues: number;
  readonly unparseableValues: number;
}

/**
 * Reads one timestamp column and reports its range.
 *
 * This is the one inventory operation that reads a data column, so it is
 * separate, explicit and off by default. It returns two normalized instants
 * and three counts. No cell value is returned, and a value that cannot be
 * normalized is counted rather than shown, so a malformed cell can never
 * reach the report through the error path either.
 */
export async function inspectTimestampRange(
  client: SheetsReadOnlyClient,
  tab: TabProperties,
  column: number,
  limits: SheetsLimits,
): Promise<TimestampRange> {
  if (!Number.isInteger(column) || column < 1 || column > limits.maximumColumnsPerTab) {
    throw fail.configuration(
      'timestamp_column_invalid',
      'the timestamp column is outside the addressable range',
      { column },
    );
  }
  const lastRow = Math.min(tab.rowCount, limits.maximumRowsPerTab);
  if (lastRow < 2) {
    return {
      tabDisplayName: safeDisplay(tab.title),
      column,
      earliest: null,
      latest: null,
      readRows: 0,
      usableValues: 0,
      unparseableValues: 0,
    };
  }
  const range = buildRange({ title: tab.title, firstRow: 2, lastRow, columns: column });
  const block = await client.values(range);

  let earliest: number | null = null;
  let latest: number | null = null;
  let usable = 0;
  let unparseable = 0;
  for (const row of block.values) {
    const cell = row[column - 1];
    if (cell === undefined || cell === null || cell === '') continue;
    const instant = serialToInstant(cell);
    if (instant === null) {
      unparseable += 1;
      continue;
    }
    usable += 1;
    const value = Date.parse(instant);
    if (earliest === null || value < earliest) earliest = value;
    if (latest === null || value > latest) latest = value;
  }

  return {
    tabDisplayName: safeDisplay(tab.title),
    column,
    earliest: earliest === null ? null : new Date(earliest).toISOString(),
    latest: latest === null ? null : new Date(latest).toISOString(),
    readRows: block.values.length,
    usableValues: usable,
    unparseableValues: unparseable,
  };
}
