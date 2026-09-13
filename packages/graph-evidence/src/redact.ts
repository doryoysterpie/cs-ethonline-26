/**
 * Credential redaction. Applied to every string the client lets out: error
 * messages, provider error bodies and probe output. Redacts known secret
 * values, any bearer token, and the legacy key-in-path gateway URL form.
 */

const BEARER_TOKEN = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g;
const LEGACY_KEY_IN_PATH = /(\/api\/)[A-Za-z0-9]{20,}(\/)/g;

export const REDACTED = '[REDACTED]';

export type Redactor = (input: string) => string;

export function createRedactor(secrets: readonly (string | undefined)[]): Redactor {
  const values = secrets.filter((s): s is string => typeof s === 'string' && s.length >= 4);
  return (input: string): string => {
    let out = input;
    for (const value of values) {
      out = out.split(value).join(REDACTED);
    }
    return out
      .replace(BEARER_TOKEN, `$1${REDACTED}`)
      .replace(LEGACY_KEY_IN_PATH, `$1${REDACTED}$2`);
  };
}
