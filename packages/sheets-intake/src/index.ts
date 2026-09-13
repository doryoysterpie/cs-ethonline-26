/**
 * `@cas/sheets-intake`
 *
 * Read-only, file-scoped intake for the one authorized Google workbook.
 *
 * The security posture of this package is a short list, and every item is
 * enforced by construction rather than by convention:
 *
 *   - **One workbook.** The identifier arrives through the environment and is
 *     checked against a committed SHA-256 pin before any request. A different
 *     workbook is refused at the boundary.
 *   - **One scope.** `spreadsheets.readonly`. No write scope string exists in
 *     this package, and a test asserts it.
 *   - **Two origins.** `sheets.googleapis.com` and `oauth2.googleapis.com`.
 *     No Drive endpoint, no file listing, no search, no export. No redirect is
 *     ever followed, so no response can move a request off those origins.
 *   - **No SDK.** The JWT-bearer flow and the two REST calls are implemented
 *     directly, so the set of reachable Google endpoints is the set written in
 *     `client.ts` and `token.ts`, not whatever a large client library exposes.
 *   - **Nothing is written, anywhere.** Not to the workbook, and not to a
 *     database: this package has no database handle and no persistence.
 *
 * The reading is pure in the sense that matters: no module here interprets a
 * formula, follows a URL found in a cell, or treats a weekly tab as a
 * published outcome. See `lineage.ts` for why the last of those is the
 * easiest mistake to make and the most expensive one.
 */

export { buildRange, columnLetters, quoteTabName, type RangeSpec } from './a1.js';
export {
  METADATA_FIELD_MASK,
  SheetsReadOnlyClient,
  type SheetsClientOptions,
  type TabProperties,
  type ValueRange,
  type WorkbookMetadata,
} from './client.js';
export {
  CREDENTIALS_VARIABLE,
  SPREADSHEET_ID_VARIABLE,
  TAB_MAP_VARIABLE,
  configSecrets,
  parseSheetsConfig,
  type ParseConfigOptions,
  type SheetsConfig,
} from './config.js';
export {
  GOOGLE_TOKEN_URI,
  isInsideDirectory,
  loadServiceAccountCredential,
  type LoadCredentialOptions,
  type ServiceAccountCredential,
} from './credentials.js';
export { DISPLAY_MAX_LENGTH, hasControlCharacter, safeDisplay } from './display.js';
export {
  SHEETS_FAILURE_KINDS,
  SheetsIntakeError,
  fail,
  isSheetsIntakeError,
  type SafeDetail,
  type SheetsFailureKind,
} from './errors.js';
export {
  inspectTimestampRange,
  inventoryWorkbook,
  type InventoryOptions,
  type TabInventory,
  type TimestampRange,
  type WorkbookInventory,
} from './inventory.js';
export { DEFAULT_LIMITS, withLimits, type SheetsLimits } from './limits.js';
export {
  EDITORIAL_LINEAGE,
  EDITORIAL_STAGES,
  PAIRING_REQUIREMENT,
  WEEKLY_TAB_LIMITATION,
  type EditorialStage,
  type LineageStage,
} from './lineage.js';
export {
  AUTHORIZED_WORKBOOK_TITLE,
  assertAuthorizedSpreadsheet,
  assertPolicyPinned,
  assertSpreadsheetIdShape,
  spreadsheetIdDigest,
  type WorkbookPolicy,
} from './policy.js';
export {
  readTab,
  totalStats,
  type ReadOptions,
  type ReadOutcome,
  type ReadStats,
  type SourceRow,
  type TabMapping,
} from './reader.js';
export { REDACTED, createRedactor, stableDigest, type Redactor } from './redact.js';
export {
  TAB_HYPOTHESES,
  analyzeHeaders,
  inferTabType,
  tabDigest,
  type HeaderAnalysis,
  type HeaderCell,
  type TabHypothesis,
  type TabInference,
} from './schema.js';
export {
  SHEETS_READONLY_SCOPE,
  TokenSource,
  buildAssertion,
  type AccessToken,
  type TokenSourceOptions,
} from './token.js';
export {
  ALLOWED_ORIGINS,
  assertAllowedUrl,
  request,
  type FetchLike,
  type TransportOptions,
  type TransportRequest,
  type TransportResponse,
} from './transport.js';
export {
  CELL_KINDS,
  FORMULA_LEADING_CHARACTERS,
  isFormulaLeading,
  normalizeCell,
  serialToInstant,
  sourceRowKey,
  type CellKind,
  type NormalizedCell,
} from './values.js';
