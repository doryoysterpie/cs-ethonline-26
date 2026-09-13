import { createHash, timingSafeEqual } from 'node:crypto';

import { fail } from './errors.js';

/**
 * The authorized-workbook policy.
 *
 * Exactly one Google spreadsheet is authorized for this project. Its
 * identifier is a secret and is supplied through environment configuration;
 * what is committed is the SHA-256 digest of that identifier, which is not a
 * secret and cannot be reversed into one.
 *
 * The check is a whitelist of size one, evaluated before any network request.
 * A different identifier is refused at the boundary: not warned about, not
 * logged and retried, not permitted with a flag. There is no override, and
 * the only way to authorize a different workbook is to change the committed
 * policy file in a reviewable commit.
 *
 * The digest is compared in constant time. The comparison is not defending a
 * secret, since the digest is public; it is defending against a future edit
 * that makes the comparison leak, and it costs nothing.
 */

/** The exact file name the owner authorized. Compared with the API's title. */
export const AUTHORIZED_WORKBOOK_TITLE = 'Cyberattack Sunday - RSS Intake';

export interface WorkbookPolicy {
  /** The workbook's exact file name, as the owner named it. */
  readonly title: string;
  /**
   * Lower-case hexadecimal SHA-256 of the authorized spreadsheet identifier,
   * or `null` while the owner has not pinned one yet. `null` fails closed:
   * every operation refuses until a digest is pinned.
   */
  readonly spreadsheetIdSha256: string | null;
  /** Free-text note carried into reports. Never a secret. */
  readonly note?: string | undefined;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
/**
 * Google file identifiers are URL-safe base64-ish strings. The bound is
 * deliberately generous at both ends: this validates shape, and the digest
 * comparison decides authorization.
 */
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,128}$/;

/** SHA-256 of a spreadsheet identifier, lower-case hexadecimal. */
export function spreadsheetIdDigest(spreadsheetId: string): string {
  return createHash('sha256').update(spreadsheetId, 'utf8').digest('hex');
}

/** Validates the shape of a configured identifier without revealing it. */
export function assertSpreadsheetIdShape(spreadsheetId: string): string {
  const trimmed = spreadsheetId.trim();
  if (trimmed.length === 0) {
    throw fail.configuration(
      'spreadsheet_id_missing',
      'GOOGLE_SHEETS_SPREADSHEET_ID is not set. Supply the authorized workbook identifier through the environment; it is never committed.',
    );
  }
  if (trimmed.includes('/') || trimmed.toLowerCase().startsWith('http')) {
    throw fail.configuration(
      'spreadsheet_id_is_url',
      'GOOGLE_SHEETS_SPREADSHEET_ID must be the bare spreadsheet identifier, not a URL.',
    );
  }
  if (!SPREADSHEET_ID.test(trimmed)) {
    throw fail.configuration(
      'spreadsheet_id_malformed',
      'GOOGLE_SHEETS_SPREADSHEET_ID is not a well-formed Google file identifier.',
      { length: trimmed.length },
    );
  }
  return trimmed;
}

/** Refuses a policy whose pinned digest is absent or malformed. */
export function assertPolicyPinned(policy: WorkbookPolicy): string {
  if (policy.title !== AUTHORIZED_WORKBOOK_TITLE) {
    throw fail.policy(
      'policy_title_unexpected',
      'the workbook policy names a file other than the authorized one',
    );
  }
  const pinned = policy.spreadsheetIdSha256;
  if (pinned === null || pinned === undefined) {
    throw fail.policy(
      'workbook_not_pinned',
      'no authorized workbook is pinned. Run the pin command once to record the digest of the authorized identifier in the policy file; the identifier itself is never printed or committed.',
    );
  }
  if (!SHA256_HEX.test(pinned)) {
    throw fail.policy(
      'workbook_pin_malformed',
      'the pinned workbook digest is not a lower-case hexadecimal SHA-256 value',
    );
  }
  return pinned;
}

/**
 * The one authorization decision. Returns the validated identifier when it is
 * the authorized workbook, and throws otherwise.
 *
 * Neither the configured identifier nor the pinned digest appears in the
 * refusal: a reader learns that the configured workbook is not the authorized
 * one, which is the whole of what they need.
 */
export function assertAuthorizedSpreadsheet(spreadsheetId: string, policy: WorkbookPolicy): string {
  const id = assertSpreadsheetIdShape(spreadsheetId);
  const pinned = assertPolicyPinned(policy);
  const actual = Buffer.from(spreadsheetIdDigest(id), 'hex');
  const expected = Buffer.from(pinned, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw fail.policy(
      'workbook_not_authorized',
      'the configured spreadsheet is not the authorized workbook. Only the pinned workbook may be read; no request was made.',
    );
  }
  return id;
}
