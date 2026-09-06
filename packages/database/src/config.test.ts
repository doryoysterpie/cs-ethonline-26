import { describe, expect, it } from 'vitest';

import {
  assertCredentialPolicy,
  assertSchemaName,
  MINIMUM_PASSWORD_LENGTH,
  parseDatabaseConfig,
  summarizeConnection,
} from './config.js';
import { isDatabaseError } from './errors.js';

const SECRET_URL = 'postgresql://user:hunter2-marker@db.internal:5432/app';

describe('parseDatabaseConfig', () => {
  it('rejects a missing DATABASE_URL with a configuration error', () => {
    expect(() => parseDatabaseConfig({})).toThrowError(/DATABASE_URL is not set/);
  });

  it('rejects a non-PostgreSQL scheme without echoing the value', () => {
    let caught: unknown;
    try {
      parseDatabaseConfig({ DATABASE_URL: 'mysql://user:hunter2-marker@host/db' });
    } catch (error) {
      caught = error;
    }
    expect(isDatabaseError(caught) && caught.kind === 'configuration').toBe(true);
    expect(String((caught as Error).message)).not.toContain('hunter2-marker');
    expect(String((caught as Error).message)).not.toContain('mysql://');
  });

  it('rejects a value that is not a URL without echoing it', () => {
    expect(() => parseDatabaseConfig({ DATABASE_URL: 'not a url hunter2-marker' })).toThrowError(
      /not a URL$/,
    );
  });

  it('accepts postgres and postgresql schemes and trims whitespace', () => {
    expect(parseDatabaseConfig({ DATABASE_URL: ` ${SECRET_URL} ` }).connectionString).toBe(
      SECRET_URL,
    );
    expect(parseDatabaseConfig({ DATABASE_URL: 'postgres://localhost/db' }).connectionString).toBe(
      'postgres://localhost/db',
    );
  });

  it('validates an optional schema name as a plain identifier', () => {
    expect(
      parseDatabaseConfig({ DATABASE_URL: SECRET_URL }, { schema: 'cas_test_abc' }).schema,
    ).toBe('cas_test_abc');
    expect(() =>
      parseDatabaseConfig({ DATABASE_URL: SECRET_URL }, { schema: 'x"; DROP' }),
    ).toThrow();
    expect(() => assertSchemaName('public')).not.toThrow();
    expect(() => assertSchemaName('Public')).toThrow();
    expect(() => assertSchemaName('a'.repeat(64))).toThrow();
  });
});

describe('credential policy', () => {
  const accept = (url: string): void => {
    expect(() => parseDatabaseConfig({ DATABASE_URL: url }), url).not.toThrow();
    expect(() => assertCredentialPolicy(url), url).not.toThrow();
  };

  // The only two rejection messages the credential policy may produce. Each
  // is a fixed sentence: it names the rule and nothing else, so it cannot
  // carry a URL, a username, a hostname or any password representation.
  const TOO_SHORT =
    'DATABASE_URL rejected: the database password must be at least 4 characters after percent-decoding';
  const UNDECODABLE = 'DATABASE_URL rejected: the database password is not valid percent-encoding';

  /**
   * Proves the rejection message is exactly the fixed sentence for its rule,
   * which is the strongest available guarantee that nothing from the input
   * reached it. Secrets of three or more characters are additionally checked
   * for absence; one and two-character values are not, because such
   * fragments occur in ordinary English and the exact-match assertion above
   * already proves the message does not vary with the input.
   */
  const reject = (url: string, expected: string, ...secrets: readonly string[]): string => {
    let caught: unknown;
    try {
      parseDatabaseConfig({ DATABASE_URL: url });
    } catch (error) {
      caught = error;
    }
    expect(isDatabaseError(caught) && caught.kind === 'configuration', url).toBe(true);
    const message = String((caught as Error).message);
    expect(message, url).toBe(expected);
    expect(message, url).not.toContain(url);
    expect(message, url).not.toContain('postgresql://');
    expect(message, url).not.toContain('postgres://');
    expect(message).not.toContain('127.0.0.1');
    for (const secret of secrets) {
      if (secret.length >= 3) expect(message, secret).not.toContain(secret);
    }
    // The same rule rejects the value on its own, for callers that check
    // before building a configuration.
    expect(() => assertCredentialPolicy(url), url).toThrowError(expected);
    return message;
  };

  it('keeps passwordless PostgreSQL URLs valid for local development', () => {
    expect(MINIMUM_PASSWORD_LENGTH).toBe(4);
    accept('postgresql://127.0.0.1:5432/cas');
    accept('postgres://localhost/cas');
    accept('postgresql://app@127.0.0.1:5432/cas');
    // A colon with nothing after it is no password at all.
    accept('postgresql://app:@127.0.0.1:5432/cas');
    accept('postgresql://localhost/db?host=/tmp');
  });

  it('rejects raw passwords of one, two and three characters', () => {
    for (const password of ['a', 'ab', 'abc']) {
      reject(`postgresql://app:${password}@127.0.0.1:5432/cas`, TOO_SHORT, password);
    }
  });

  it('rejects percent-encoded passwords whose decoded value is one, two or three characters', () => {
    const encoded: [raw: string, decoded: string][] = [
      ['%41', 'A'],
      ['%41%42', 'AB'],
      ['%41%42%43', 'ABC'],
      ['%40', '@'],
      ['a%40b', 'a@b'],
    ];
    for (const [raw, decoded] of encoded) {
      reject(`postgresql://app:${raw}@127.0.0.1:5432/cas`, TOO_SHORT, raw, decoded);
    }
  });

  it('rejects malformed percent-encoding rather than accepting an undecodable credential', () => {
    for (const raw of ['%zz%zz%zz%zz', 'abcd%', 'abcd%2']) {
      reject(`postgresql://app:${raw}@127.0.0.1:5432/cas`, UNDECODABLE, raw);
    }
  });

  it('accepts a decoded password of four or more characters, raw or encoded', () => {
    accept('postgresql://app:abcd@127.0.0.1:5432/cas');
    accept('postgresql://app:hunter2-marker@db.internal:5432/app');
    // Four decoded characters written as twelve encoded ones.
    accept('postgresql://app:%41%42%43%44@127.0.0.1:5432/cas');
    accept('postgresql://app:p%40ss-marker@127.0.0.1:5432/cas');
  });

  it('applies the same rule through every database entry point', () => {
    // Each entry point builds its handle from parseDatabaseConfig, so a
    // rejected credential stops migration, check, import and report alike.
    const short = { DATABASE_URL: 'postgresql://app:abc@127.0.0.1:5432/cas' };
    expect(() => parseDatabaseConfig(short)).toThrowError(/at least 4 characters/);
    expect(() => parseDatabaseConfig(short, { schema: 'cas_test_x' })).toThrowError(
      /at least 4 characters/,
    );
  });

  it('leaves values that are not PostgreSQL URLs to the surrounding validation', () => {
    expect(() => assertCredentialPolicy('not a url at all')).not.toThrow();
    expect(() => assertCredentialPolicy('https://user:ab@example.test/x')).not.toThrow();
    expect(() => parseDatabaseConfig({ DATABASE_URL: 'https://user:ab@example.test/x' })).toThrow(
      /scheme must be postgres/,
    );
  });
});

describe('summarizeConnection', () => {
  it('classifies loopback TCP, remote TCP and unix sockets without exposing hosts', () => {
    expect(summarizeConnection('postgresql://127.0.0.1:5432/db')).toEqual({
      transport: 'loopback-tcp',
      passwordPresent: false,
      sslRequested: false,
    });
    expect(summarizeConnection(SECRET_URL)).toEqual({
      transport: 'remote-tcp',
      passwordPresent: true,
      sslRequested: false,
    });
    expect(summarizeConnection('postgresql://localhost/db?host=/tmp')).toEqual({
      transport: 'unix-socket',
      passwordPresent: false,
      sslRequested: false,
    });
    expect(summarizeConnection('postgresql://db.internal/db?sslmode=require').sslRequested).toBe(
      true,
    );
  });
});
