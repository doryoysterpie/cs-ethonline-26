import { fail } from './errors.js';
import type { SheetsLimits } from './limits.js';
import type { TokenSource } from './token.js';
import { request, type FetchLike } from './transport.js';

/**
 * The Google Sheets REST surface this connector uses.
 *
 * Two endpoints, both reads, both on `sheets.googleapis.com`:
 *
 *   - `GET /v4/spreadsheets/{id}` with a field mask that selects the
 *     workbook's title and each tab's properties, and nothing else. Grid data
 *     is never requested: `includeGridData` does not appear in this file, and
 *     the mask makes a cell value unreturnable even if it did.
 *   - `GET /v4/spreadsheets/{id}/values/{range}` for an explicit A1 range.
 *
 * There is no Drive endpoint, no file listing, no search, no export, no
 * `batchUpdate`, and no method that writes. The base URL is a frozen constant
 * and every request goes through the transport allowlist, so the set of
 * reachable URLs is enumerable by reading this one file.
 *
 * Values are requested as `UNFORMATTED_VALUE`, so the connector receives the
 * data rather than a locale-formatted rendering of it, and dates as
 * `SERIAL_NUMBER`, so a timestamp is a deterministic number this connector
 * normalizes itself instead of a string whose meaning depends on the
 * workbook's locale. Nothing here evaluates a formula: every returned string
 * is inert text, and a string that merely begins like a formula is flagged
 * downstream and never re-emitted as one.
 */

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * The field mask for the metadata call. It selects structure only. Adding a
 * `sheets.data` path here would make the call able to return cell values, so
 * this constant is asserted verbatim by a test.
 */
export const METADATA_FIELD_MASK =
  'properties.title,properties.locale,properties.timeZone,sheets.properties';

export interface SheetsClientOptions {
  readonly tokens: TokenSource;
  readonly limits: SheetsLimits;
  readonly fetchImpl?: FetchLike | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** One tab's structural properties, exactly as the metadata mask returns them. */
export interface TabProperties {
  readonly sheetId: number;
  readonly title: string;
  readonly index: number;
  readonly sheetType: string;
  readonly hidden: boolean;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly frozenRowCount: number;
}

export interface WorkbookMetadata {
  readonly title: string;
  readonly locale: string | null;
  readonly timeZone: string | null;
  readonly tabs: readonly TabProperties[];
}

/** A rectangular block of values, as returned for one explicit range. */
export interface ValueRange {
  /** The range the API says it answered for. Sanitized before any display. */
  readonly range: string;
  /** Row-major cells. A short row means trailing cells were empty. */
  readonly values: readonly (readonly unknown[])[];
}

function parseJson(text: string, code: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw fail.schema(code, 'the API response could not be parsed as JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail.schema(code, 'the API response is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Turns a non-success status into a fixed, actionable refusal.
 *
 * The response body is never read into the message. A Google error body can
 * quote the request, and the request path carries the spreadsheet identifier;
 * echoing it would defeat the rule that the identifier never appears in
 * output. The status is sufficient to distinguish every case an operator acts
 * on differently.
 */
function httpFailure(status: number): never {
  if (status === 401) {
    throw fail.authorization(
      'api_unauthorized',
      'the API rejected the access token. The token may have expired, or the service-account key may have been revoked.',
      { status },
    );
  }
  if (status === 403) {
    throw fail.authorization(
      'api_forbidden',
      'the API refused access to the workbook. Confirm the authorized file is shared with the service account as Viewer, and that the Google Sheets API is enabled for its project.',
      { status },
    );
  }
  if (status === 404) {
    throw fail.http(
      'api_not_found',
      'the API reports no such workbook or range. This is also what a revoked share looks like.',
      { status },
    );
  }
  if (status === 429) {
    throw fail.http('api_rate_limited', 'the API is rate-limiting this service account', {
      status,
    });
  }
  throw fail.http('api_error', 'the API answered with an unsuccessful status', { status });
}

/**
 * A read-only client for one already-authorized spreadsheet.
 *
 * The identifier is supplied once, at construction, by a caller that has
 * already put it through `assertAuthorizedSpreadsheet`. It is held privately
 * and is never returned, logged or placed in an error.
 */
export class SheetsReadOnlyClient {
  readonly #spreadsheetId: string;
  readonly #options: SheetsClientOptions;

  constructor(spreadsheetId: string, options: SheetsClientOptions) {
    this.#spreadsheetId = spreadsheetId;
    this.#options = options;
  }

  async #get(url: string, code: string): Promise<Record<string, unknown>> {
    const token = await this.#options.tokens.accessToken(this.#options.signal);
    const response = await request(
      {
        url,
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
        idempotent: true,
      },
      {
        limits: this.#options.limits,
        ...(this.#options.fetchImpl === undefined ? {} : { fetchImpl: this.#options.fetchImpl }),
        ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
        ...(this.#options.sleep === undefined ? {} : { sleep: this.#options.sleep }),
      },
    );
    if (response.status !== 200) httpFailure(response.status);
    return parseJson(response.text, code);
  }

  /** Structure only: the workbook title and each tab's properties. */
  async metadata(): Promise<WorkbookMetadata> {
    const url =
      `${SHEETS_API_BASE}/${encodeURIComponent(this.#spreadsheetId)}` +
      `?fields=${encodeURIComponent(METADATA_FIELD_MASK)}`;
    const body = await this.#get(url, 'metadata_response_invalid');
    const properties = body['properties'];
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
      throw fail.schema('metadata_response_invalid', 'the workbook metadata carries no properties');
    }
    const props = properties as Record<string, unknown>;
    const title = props['title'];
    if (typeof title !== 'string') {
      throw fail.schema('metadata_response_invalid', 'the workbook metadata carries no title');
    }
    const rawSheets = body['sheets'];
    if (!Array.isArray(rawSheets)) {
      throw fail.schema('metadata_response_invalid', 'the workbook metadata carries no tab list');
    }
    if (rawSheets.length > this.#options.limits.maximumTabs) {
      throw fail.structural(
        'workbook_too_many_tabs',
        'the workbook declares more tabs than the configured bound permits',
        { tabs: rawSheets.length, maximum: this.#options.limits.maximumTabs },
      );
    }

    const tabs: TabProperties[] = [];
    for (const [index, entry] of rawSheets.entries()) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw fail.schema('metadata_response_invalid', 'a tab entry is not an object', { index });
      }
      const tabProperties = (entry as Record<string, unknown>)['properties'];
      if (
        tabProperties === null ||
        typeof tabProperties !== 'object' ||
        Array.isArray(tabProperties)
      ) {
        throw fail.schema('metadata_response_invalid', 'a tab carries no properties', { index });
      }
      const p = tabProperties as Record<string, unknown>;
      const grid = p['gridProperties'];
      const gridProps =
        grid !== null && typeof grid === 'object' && !Array.isArray(grid)
          ? (grid as Record<string, unknown>)
          : {};
      const tabTitle = p['title'];
      if (typeof tabTitle !== 'string') {
        throw fail.schema('metadata_response_invalid', 'a tab carries no title', { index });
      }
      const asCount = (value: unknown): number =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
      tabs.push({
        sheetId: asCount(p['sheetId']),
        title: tabTitle,
        index: typeof p['index'] === 'number' ? p['index'] : index,
        sheetType: typeof p['sheetType'] === 'string' ? p['sheetType'] : 'UNKNOWN',
        hidden: p['hidden'] === true,
        rowCount: asCount(gridProps['rowCount']),
        columnCount: asCount(gridProps['columnCount']),
        frozenRowCount: asCount(gridProps['frozenRowCount']),
      });
    }

    return {
      title,
      locale: typeof props['locale'] === 'string' ? props['locale'] : null,
      timeZone: typeof props['timeZone'] === 'string' ? props['timeZone'] : null,
      tabs,
    };
  }

  /** One explicit A1 range, as unformatted values with serial-number dates. */
  async values(range: string): Promise<ValueRange> {
    const url =
      `${SHEETS_API_BASE}/${encodeURIComponent(this.#spreadsheetId)}` +
      `/values/${encodeURIComponent(range)}` +
      `?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
    const body = await this.#get(url, 'values_response_invalid');
    const answered = body['range'];
    const rawValues = body['values'];
    if (rawValues !== undefined && !Array.isArray(rawValues)) {
      throw fail.schema('values_response_invalid', 'the value range is not an array of rows');
    }
    const rows = (rawValues ?? []) as unknown[];
    const values: unknown[][] = [];
    for (const row of rows) {
      if (!Array.isArray(row)) {
        throw fail.schema('values_response_invalid', 'a value row is not an array');
      }
      values.push(row as unknown[]);
    }
    return {
      range: typeof answered === 'string' ? answered : range,
      values,
    };
  }
}
