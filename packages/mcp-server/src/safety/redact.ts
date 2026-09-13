/**
 * Redaction of everything this server emits: tool results, error text and
 * the stderr log. One redactor covers every secret the process can hold:
 * the whole `DATABASE_URL`, its password, the `GRAPH_API_KEY`, any bearer
 * token, any PostgreSQL URL shape and the legacy key-in-path gateway URL form.
 *
 * Track D finding F3: a credential that reaches stored or provider text in an
 * encoded form survived a redactor that matched the literal value only. Every
 * secret is therefore expanded, once and by a bounded rule, into the forms it
 * can plausibly take in transit, and every form is redacted:
 *
 *   - the raw value;
 *   - its percent-decoded form, when it decodes at all and differs;
 *   - `encodeURIComponent` of each of those, with upper-case and lower-case
 *     percent escapes;
 *   - `encodeURI` of each, both cases, because it leaves `+`, `/` and `=` bare;
 *   - the `application/x-www-form-urlencoded` form of each, both cases,
 *     because it encodes spaces as `+` and `!'()*` as escapes.
 *
 * The expansion is applied to the secret, never to untrusted content: no
 * output is decoded, repeatedly or otherwise, to look for a secret inside it.
 *
 * Redaction runs before display escaping, truncation and serialization, so a
 * secret cannot be split by a bound or altered by an escape before it is
 * matched. Values shorter than four characters are ignored, exactly as the
 * `@cas/database` redactor ignores them, because such a value matches ordinary
 * words; the database configuration refuses passwords that short for that
 * reason (`docs/SECURITY.md` section 11).
 */

export const REDACTED = '[REDACTED]';

/** Shortest secret form that is redacted. */
export const MINIMUM_SECRET_LENGTH = 4;

export type Redactor = (input: string) => string;

const CONNECTION_URL = /\bpostgres(?:ql)?:\/\/[^\s'"`<>]+/gi;
const BEARER_TOKEN = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g;
const LEGACY_KEY_IN_PATH = /(\/api\/)[A-Za-z0-9]{20,}(\/)/g;
const UPPER_ESCAPE = /%[0-9A-F]{2}/g;

function lowerEscapes(value: string): string {
  return value.replace(UPPER_ESCAPE, (escape) => escape.toLowerCase());
}

function decodedOnce(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded === value ? null : decoded;
  } catch {
    return null;
  }
}

function formEncoded(value: string): string {
  return new URLSearchParams([['v', value]]).toString().slice(2);
}

/**
 * The bounded set of forms one secret is redacted in. At most twenty-six
 * strings: the raw value and its single percent-decoding, each in the raw
 * form and in three encodings with two escape cases. Nothing here decodes
 * more than once and nothing here decodes output.
 */
export function secretVariants(secret: string): string[] {
  // A value below the minimum is not a secret this redactor handles, in any form.
  if (secret.length < MINIMUM_SECRET_LENGTH) return [];
  const bases = [secret];
  const decoded = decodedOnce(secret);
  if (decoded !== null) bases.push(decoded);
  const forms = new Set<string>();
  for (const base of bases) {
    forms.add(base);
    for (const encoded of [encodeURIComponent(base), encodeURI(base), formEncoded(base)]) {
      forms.add(encoded);
      forms.add(lowerEscapes(encoded));
    }
  }
  return [...forms].filter((form) => form.length >= MINIMUM_SECRET_LENGTH);
}

export function createRedactor(secrets: readonly (string | null | undefined)[]): Redactor {
  const values = [
    ...new Set(
      secrets
        .filter((s): s is string => typeof s === 'string')
        .flatMap((secret) => secretVariants(secret)),
    ),
  ].sort((a, b) => b.length - a.length);
  return (input: string): string => {
    let out = input;
    for (const value of values) {
      out = out.split(value).join(REDACTED);
    }
    return out
      .replace(CONNECTION_URL, REDACTED)
      .replace(BEARER_TOKEN, `$1${REDACTED}`)
      .replace(LEGACY_KEY_IN_PATH, `$1${REDACTED}$2`);
  };
}

/**
 * The secret values a connection string carries: the whole string and, when
 * present, the password in both its raw and percent-decoded forms. The
 * variant expansion above then covers each encoding of each.
 */
export function connectionSecrets(connectionString: string | undefined): string[] {
  if (connectionString === undefined || connectionString.trim().length === 0) return [];
  const secrets = [connectionString.trim()];
  try {
    const url = new URL(connectionString.trim());
    if (url.password.length > 0) {
      secrets.push(url.password);
      try {
        secrets.push(decodeURIComponent(url.password));
      } catch {
        // Not percent-encoded; the raw form is already listed.
      }
    }
  } catch {
    // Unparseable strings are still redacted as a whole.
  }
  return secrets;
}

/** Applies the redactor to every string reachable from a JSON value. Keys are redacted too. */
export function redactDeep<T>(value: T, redact: Redactor): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, redact)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[redact(key)] = redactDeep(entry, redact);
    }
    return out as T;
  }
  return value;
}
