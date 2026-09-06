/**
 * Redaction for everything this layer or its callers print. Removes the full
 * connection string, its password component, and any PostgreSQL connection
 * URL shape, so a credential-bearing URL cannot reach a log, an error message
 * or a report (docs/SECURITY.md section 2).
 */

export const REDACTED = '[REDACTED]';

export type Redactor = (input: string) => string;

const CONNECTION_URL = /\bpostgres(?:ql)?:\/\/[^\s'"`<>]+/gi;

export function createRedactor(secrets: readonly (string | null | undefined)[]): Redactor {
  const values = [...new Set(secrets.filter((s): s is string => typeof s === 'string'))]
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
  return (input: string): string => {
    let out = input;
    for (const value of values) {
      out = out.split(value).join(REDACTED);
    }
    return out.replace(CONNECTION_URL, REDACTED);
  };
}

/**
 * The secret values a connection string carries: the whole string and, when
 * present, the password in both its raw and percent-decoded forms.
 */
export function connectionSecrets(connectionString: string): string[] {
  const secrets = [connectionString];
  try {
    const url = new URL(connectionString);
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
