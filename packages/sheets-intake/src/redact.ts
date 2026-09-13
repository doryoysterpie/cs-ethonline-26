import { createHash } from 'node:crypto';

/**
 * Redaction for everything this connector lets out.
 *
 * Three classes of value must never reach a log, an error message or a report:
 *
 *   1. **Credential material.** The service-account private key, any access
 *      token, and any `Authorization` header value.
 *   2. **The spreadsheet identifier**, and therefore any URL containing it.
 *      The workbook is private; its identifier is a capability-shaped value
 *      and the owner's instruction is that it never appears in output.
 *   3. **Encoded forms of either.** A value that survives redaction because it
 *      was percent-encoded or base64-encoded on the way out is not redacted.
 *      Every secret is therefore registered together with its percent-encoded,
 *      base64 and base64url forms.
 *
 * Redaction is a last line of defence, not the first. The connector is built
 * so that these values are not placed into strings at all; this guard exists
 * because "not placed into strings" is a property that a future edit can break
 * silently, and a redactor cannot.
 */

export const REDACTED = '[REDACTED]';

export type Redactor = (input: string) => string;

/** Any bearer token, whatever its value. */
const BEARER_TOKEN = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
/** A PEM private key block, however it was line-wrapped. */
const PEM_PRIVATE_KEY =
  /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g;
/** A Google OAuth access token, which is recognisable by prefix. */
const GOOGLE_ACCESS_TOKEN = /ya29\.[A-Za-z0-9._-]{10,}/g;
/**
 * A Google spreadsheet URL, whatever identifier it carries. This catches an
 * identifier that reached a string by a route the explicit list missed.
 */
const SPREADSHEET_URL = /(https?:\/\/docs\.google\.com\/spreadsheets\/d\/)[A-Za-z0-9_-]{10,}/gi;
/** A bare Google file identifier appearing next to a telltale key name. */
const IDENTIFIER_ASSIGNMENT =
  /((?:spreadsheet|sheet|file|document)[_-]?id"?\s*[:=]\s*"?)[A-Za-z0-9_-]{20,}/gi;

/** Every encoded form of one secret that redaction must also catch. */
function encodedForms(value: string): string[] {
  const forms = new Set<string>([value, value.toLowerCase()]);
  const add = (candidate: string): void => {
    if (candidate.length >= 8) {
      forms.add(candidate);
      forms.add(candidate.toLowerCase());
    }
  };
  try {
    add(encodeURIComponent(value));
  } catch {
    // An unencodable value keeps its raw form alone.
  }
  try {
    add(decodeURIComponent(value));
  } catch {
    // A value that is not valid percent-encoding keeps its raw form alone.
  }
  const utf8 = Buffer.from(value, 'utf8');
  add(utf8.toString('base64'));
  add(utf8.toString('base64url'));
  add(utf8.toString('hex'));
  return [...forms];
}

/**
 * Builds a redactor over the given secrets.
 *
 * Values shorter than eight characters are ignored: a short value would match
 * ordinary text everywhere and turn a readable report into redaction noise,
 * which hides more than it protects. Longer needles are replaced first, so a
 * secret that contains another secret is not left partly visible.
 */
export function createRedactor(secrets: readonly (string | undefined | null)[]): Redactor {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    for (const form of encodedForms(secret)) needles.add(form);
  }
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  return (input: string): string => {
    let out = input;
    for (const needle of ordered) out = out.split(needle).join(REDACTED);
    return out
      .replace(PEM_PRIVATE_KEY, REDACTED)
      .replace(GOOGLE_ACCESS_TOKEN, REDACTED)
      .replace(BEARER_TOKEN, `$1${REDACTED}`)
      .replace(SPREADSHEET_URL, `$1${REDACTED}`)
      .replace(IDENTIFIER_ASSIGNMENT, `$1${REDACTED}`);
  };
}

/**
 * A short, stable, non-reversible label for a value that may not be printed.
 *
 * Twelve hexadecimal characters of a SHA-256 digest: enough for a human to
 * confirm that two runs named the same workbook or the same tab, and far too
 * little to recover what was named.
 */
export function stableDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}
