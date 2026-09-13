import {
  WEEKLY_TAB_LIMITATION,
  safeDisplay,
  type Redactor,
  type ReadStats,
  type TimestampRange,
  type WorkbookInventory,
} from '@cas/sheets-intake';

import { toSingleLine } from '../editorial/display.js';

/**
 * Count-only, identifier-only output for the Sheets commands.
 *
 * The same boundary Sprints 2 to 5 use: every line is redacted, rendered as
 * exactly one physical line, and built from a fixed vocabulary. Tab names and
 * header names arrive already escaped by the connector; they pass through the
 * single-line guard again here, because a value that is escaped twice is
 * merely ugly and a value that is escaped never is a forged line.
 *
 * The workbook identifier never appears. Where a report needs to name the
 * workbook, it prints a twelve-character digest, which lets a reader confirm
 * two runs read the same file without learning which file that is.
 */

function line(value: string, redact: Redactor): string {
  return toSingleLine(redact(value));
}

/** The inventory as printed lines. Structure, counts and warnings only. */
export function formatInventory(
  inventory: WorkbookInventory,
  context: { readonly workbookDigest: string; readonly clientEmail: string },
  redact: Redactor,
): string[] {
  const lines: string[] = [
    `sheets:inventory: workbook=${context.workbookDigest} titleMatch=${inventory.titleMatches ? 'yes' : 'no'} readAs=${safeDisplay(context.clientEmail)}`,
    `expected: ${safeDisplay(inventory.expectedTitle)}`,
    `workbook: tabs=${inventory.tabCount} visible=${inventory.visibleTabCount} hidden=${inventory.hiddenTabCount} inspected=${inventory.tabsInspected} skipped=${inventory.tabsSkipped}`,
    `locale: ${safeDisplay(inventory.locale ?? 'absent')} timeZone=${safeDisplay(inventory.timeZone ?? 'absent')}`,
  ];
  for (const warning of inventory.warnings) lines.push(`warning: ${safeDisplay(warning)}`);

  for (const tab of inventory.tabs) {
    lines.push(
      `tab: index=${tab.index} digest=${tab.digest} name=${tab.displayName}` +
        ` escaped=${tab.nameSanitized ? 'yes' : 'no'} type=${safeDisplay(tab.sheetType)}` +
        ` hidden=${tab.hidden ? 'yes' : 'no'} declaredRows=${tab.declaredRows}` +
        ` declaredColumns=${tab.declaredColumns} frozenRows=${tab.frozenRows}`,
    );
    if (tab.headers !== null) {
      const names = tab.headers.headers
        .map((header) => `${header.letters}=${header.blank ? '(blank)' : header.display}`)
        .join(' | ');
      lines.push(`headers: count=${tab.headers.headers.length} ${names}`);
      lines.push(
        `headerIssues: blank=${tab.headers.blankColumns.length} duplicateGroups=${tab.headers.duplicates.length} escaped=${tab.headers.anySanitized ? 'yes' : 'no'}`,
      );
    }
    if (tab.inference !== null) {
      lines.push(
        `inference: hypothesis=${tab.inference.hypothesis} confidence=${tab.inference.confidence.toFixed(2)}` +
          ` provisional=yes evidence=${tab.inference.evidence.join(',') || '-'}`,
      );
    }
    for (const warning of tab.warnings) lines.push(`  warning: ${safeDisplay(warning)}`);
  }

  // The sentence the whole track exists to keep in front of a reader.
  lines.push(`lineage: ${WEEKLY_TAB_LIMITATION}`);
  lines.push(
    'lineage: an inferred tab type is a hypothesis for a human to confirm; the ingestion adapter takes only an explicit mapping the owner approved',
  );
  return lines.map((entry) => line(entry, redact));
}

/** A timestamp range: two instants and three counts, never a cell. */
export function formatTimestampRange(range: TimestampRange, redact: Redactor): string[] {
  return [
    `sheets:timestamps: tab=${range.tabDisplayName} column=${range.column}`,
    `range: earliest=${range.earliest ?? 'none'} latest=${range.latest ?? 'none'}`,
    `counts: rowsRead=${range.readRows} usable=${range.usableValues} unreadable=${range.unparseableValues}`,
  ].map((entry) => line(entry, redact));
}

/** A dry run's completion: counts alone. */
export function formatReadStats(
  stats: ReadStats,
  context: { readonly workbookDigest: string; readonly dryRun: boolean },
  warnings: readonly string[],
  redact: Redactor,
): string[] {
  const lines = [
    `sheets:read: workbook=${context.workbookDigest} mode=${context.dryRun ? 'dry-run' : 'collected'} status=no_database_write`,
    `counts: tabs=${stats.tabsRead} rowsRead=${stats.rowsRead} rowsEmitted=${stats.rowsEmitted} rowsBlank=${stats.rowsBlank} pages=${stats.pages}`,
    `identity: distinctKeys=${stats.distinctKeys} duplicateRows=${stats.rowsEmitted - stats.distinctKeys}`,
    `cells: formulaLeading=${stats.cellsFormulaLeading} requiringEscape=${stats.cellsRequiringEscape}`,
    `timestamps: normalized=${stats.timestampsNormalized} unreadable=${stats.timestampsUnreadable}`,
  ];
  for (const warning of warnings) lines.push(`warning: ${safeDisplay(warning)}`);
  return lines.map((entry) => line(entry, redact));
}

/** The pin command's output: a digest and an instruction. Never the identifier. */
export function formatPin(pin: {
  readonly digest: string;
  readonly shortDigest: string;
}): string[] {
  return [
    `sheets:pin: digest=${pin.digest}`,
    `sheets:pin: short=${pin.shortDigest}`,
    'sheets:pin: paste the digest into data/policy/authorized-workbook.json as spreadsheetIdSha256, in its own commit',
    'sheets:pin: the spreadsheet identifier was read from the environment and is not printed here or anywhere',
  ];
}
