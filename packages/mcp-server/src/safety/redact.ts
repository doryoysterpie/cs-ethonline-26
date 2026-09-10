/**
 * Redaction of everything this server emits: tool results, error text and
 * the stderr log. One redactor covers every secret the process can hold:
 * the whole `DATABASE_URL`, its raw and percent-decoded password, the
 * `GRAPH_API_KEY`, any bearer token, any PostgreSQL URL shape and the legacy
 * key-in-path gateway URL form.
 *
 * Secret values shorter than four characters are ignored, exactly as the
 * `@cas/database` redactor ignores them, because such a value matches
 * ordinary words; the database configuration refuses passwords that short for
 * that reason (`docs/SECURITY.md` section 11).
 */

export const REDACTED = '[REDACTED]';

export type Redactor = (input: string) => string;

const CONNECTION_URL = /\bpostgres(?:ql)?:\/\/[^\s'"`<>]+/gi;
const BEARER_TOKEN = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g;
const LEGACY_KEY_IN_PATH = /(\/api\/)[A-Za-z0-9]{20,}(\/)/g;

export function createRedactor(secrets: readonly (string | null | undefined)[]): Redactor {
  const values = [...new Set(secrets.filter((s): s is string => typeof s === 'string'))]
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
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
 * present, the password in both its raw and percent-decoded forms.
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
