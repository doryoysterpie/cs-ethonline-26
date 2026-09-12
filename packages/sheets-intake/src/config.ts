import { fail } from './errors.js';
import { DEFAULT_LIMITS, withLimits, type SheetsLimits } from './limits.js';
import { assertSpreadsheetIdShape } from './policy.js';

/**
 * Configuration, validated before anything reaches the network.
 *
 * Every value this connector needs comes from the environment, is checked
 * here, and is checked completely: a run that is going to fail on a malformed
 * credential path fails before it authenticates, not after. This is the same
 * rule `@cas/database` applies to its connection string, for the same reason —
 * a partial failure halfway through a read is harder to reason about than a
 * refusal at the start.
 *
 * Nothing here prints a value. A refusal names the variable and the condition;
 * the variable's contents are never echoed, not even when malformed, because a
 * malformed secret is still a secret.
 */

/** The authorized workbook's identifier. Secret. Never committed, never printed. */
export const SPREADSHEET_ID_VARIABLE = 'GOOGLE_SHEETS_SPREADSHEET_ID';
/** Path to the service-account key. The Application Default Credentials name. */
export const CREDENTIALS_VARIABLE = 'GOOGLE_APPLICATION_CREDENTIALS';
/** Optional. Path to the reviewed tab mapping, once the owner has approved one. */
export const TAB_MAP_VARIABLE = 'GOOGLE_SHEETS_TAB_MAP';

export interface SheetsConfig {
  readonly spreadsheetId: string;
  readonly credentialsPath: string;
  readonly tabMapPath: string | null;
  readonly limits: SheetsLimits;
}

export interface ParseConfigOptions {
  readonly limits?: Partial<SheetsLimits> | undefined;
  /**
   * Whether a credential path is required. The pin command needs the
   * identifier alone, and asking for credentials it will not use would make
   * the one command that needs no network access need a key.
   */
  readonly requireCredentials?: boolean | undefined;
}

function readVariable(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | null {
  const value = env[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Reads and validates the connector's configuration.
 *
 * The identifier's shape is checked here; its authorization is checked
 * separately against the pinned policy, so a run that is merely misconfigured
 * is distinguishable in the output from a run that named the wrong workbook.
 */
export function parseSheetsConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: ParseConfigOptions = {},
): SheetsConfig {
  const rawId = readVariable(env, SPREADSHEET_ID_VARIABLE);
  if (rawId === null) {
    throw fail.configuration(
      'spreadsheet_id_missing',
      `${SPREADSHEET_ID_VARIABLE} is not set. Supply the authorized workbook identifier through the environment or a mounted secret; it is never committed.`,
    );
  }
  const spreadsheetId = assertSpreadsheetIdShape(rawId);

  const credentialsPath = readVariable(env, CREDENTIALS_VARIABLE);
  if (options.requireCredentials !== false && credentialsPath === null) {
    throw fail.configuration(
      'credentials_missing',
      `${CREDENTIALS_VARIABLE} is not set. Point it at the service-account key on a path outside the repository, readable only by its owner.`,
    );
  }

  const tabMapPath = readVariable(env, TAB_MAP_VARIABLE);

  return {
    spreadsheetId,
    credentialsPath: credentialsPath ?? '',
    tabMapPath,
    limits: options.limits === undefined ? DEFAULT_LIMITS : withLimits(options.limits),
  };
}

/**
 * The secrets a redactor must cover for this configuration.
 *
 * The identifier is included because the owner's rule is that it never appears
 * in output, and a redactor that does not know it cannot enforce that.
 */
export function configSecrets(config: Pick<SheetsConfig, 'spreadsheetId'>): readonly string[] {
  return [config.spreadsheetId];
}
