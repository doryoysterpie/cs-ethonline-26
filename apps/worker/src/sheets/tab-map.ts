import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IngestionError } from '../editorial/errors.js';
import { hasControlCharacter } from '../editorial/display.js';
import type { SheetsImportMapping } from './import.js';

/**
 * The committed declaration of which tabs the Sheets importer may read and
 * what each one is. A tab's editorial stage is never inferred from its name
 * or its shape: the owner declares it here, in a file a reviewer reads, and
 * the import command refuses a tab the file does not name.
 *
 * The file holds no identifier and no digest of one. Tab titles are the
 * owner's own names for the parts of the workbook and are already printed
 * by the inventory.
 */

export const TAB_MAP_PATH = fileURLToPath(
  new URL('../../../../data/policy/sheets-tab-map.json', import.meta.url),
);
/** An environment override for the declaration's path. The default is the committed file. */
export const TAB_MAP_VARIABLE = 'GOOGLE_SHEETS_TAB_MAP';

const MAXIMUM_TITLE_LENGTH = 100;
const SOURCE_KINDS = new Set(['master', 'weekly']);

export interface TabMapPolicy {
  readonly tabs: readonly SheetsImportMapping[];
}

function configuration(code: string, message: string): IngestionError {
  return new IngestionError('configuration', code, message);
}

function invalid(message: string): IngestionError {
  return configuration('tab_map_invalid', `the tab map is invalid: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalid(`${name} must be a positive integer`);
  }
  return value;
}

function mappingFrom(entry: unknown, index: number): SheetsImportMapping {
  if (!isRecord(entry)) throw invalid(`entry ${index} is not an object`);
  const title = entry['title'];
  if (
    typeof title !== 'string' ||
    title.length === 0 ||
    title.length > MAXIMUM_TITLE_LENGTH ||
    hasControlCharacter(title)
  ) {
    throw invalid(`entry ${index} carries no usable title`);
  }
  const stage = entry['stage'];
  if (typeof stage !== 'string' || stage.length === 0) {
    throw invalid(`entry ${index} declares no stage`);
  }
  const sourceKind = entry['sourceKind'];
  if (typeof sourceKind !== 'string' || !SOURCE_KINDS.has(sourceKind)) {
    throw invalid(`entry ${index} declares no source kind`);
  }
  const rawColumns = entry['timestampColumns'];
  if (!Array.isArray(rawColumns)) throw invalid(`entry ${index} declares no timestamp columns`);
  const timestampColumns = rawColumns.map((column, position) =>
    positiveInteger(column, `entry ${index} timestamp column ${position}`),
  );
  return {
    title,
    stage,
    sourceKind: sourceKind as SheetsImportMapping['sourceKind'],
    firstDataRow: positiveInteger(entry['firstDataRow'], `entry ${index} firstDataRow`),
    columns: positiveInteger(entry['columns'], `entry ${index} columns`),
    timestampColumns,
  };
}

/** Reads the committed declaration. A malformed file is a refusal, never a default. */
export async function loadTabMapPolicy(policyPath: string = TAB_MAP_PATH): Promise<TabMapPolicy> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(policyPath, 'utf8')) as unknown;
  } catch {
    throw configuration(
      'tab_map_unreadable',
      `the tab map at ${path.basename(policyPath)} could not be read as JSON`,
    );
  }
  if (!isRecord(parsed)) throw invalid('not a JSON object');
  const rawTabs = parsed['tabs'];
  if (!Array.isArray(rawTabs)) throw invalid('no tabs array');
  const tabs = rawTabs.map((entry, index) => mappingFrom(entry, index));
  const titles = new Set<string>();
  for (const tab of tabs) {
    if (titles.has(tab.title)) throw invalid('a title is declared twice');
    titles.add(tab.title);
  }
  return { tabs };
}

/** The declaration for one tab, by exact title. An undeclared tab is refused. */
export function mappingForTab(policy: TabMapPolicy, title: string): SheetsImportMapping {
  const mapping = policy.tabs.find((tab) => tab.title === title);
  if (mapping === undefined) {
    throw configuration(
      'tab_not_declared',
      'the tab is not declared in the tab map; declare it in a reviewed commit first',
    );
  }
  return mapping;
}

/** The declaration's path: the environment override when set, else the committed file. */
export function resolveTabMapPath(env: Readonly<Record<string, string | undefined>>): string {
  const value = env[TAB_MAP_VARIABLE];
  if (typeof value !== 'string') return TAB_MAP_PATH;
  const trimmed = value.trim();
  return trimmed.length === 0 ? TAB_MAP_PATH : trimmed;
}
