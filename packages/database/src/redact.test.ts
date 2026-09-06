import { describe, expect, it } from 'vitest';

import { connectionSecrets, createRedactor, REDACTED } from './redact.js';

const URL_WITH_PASSWORD = 'postgresql://app:p%40ss-marker@db.internal:5432/cas';

describe('createRedactor', () => {
  it('removes the whole connection string, the raw and decoded password, and any PostgreSQL URL', () => {
    const redact = createRedactor(connectionSecrets(URL_WITH_PASSWORD));
    const line = `failed for ${URL_WITH_PASSWORD} with password p@ss-marker and p%40ss-marker; also postgres://x:y@h/db`;
    const out = redact(line);
    expect(out).not.toContain('p@ss-marker');
    expect(out).not.toContain('p%40ss-marker');
    expect(out).not.toContain('postgresql://');
    expect(out).not.toContain('postgres://');
    expect(out).toContain(REDACTED);
  });

  it('ignores empty and very short secrets so it cannot blank out ordinary text', () => {
    const redact = createRedactor([undefined, null, '', 'ab']);
    expect(redact('ab cd')).toBe('ab cd');
  });

  it('lists only the connection string when there is no password', () => {
    expect(connectionSecrets('postgresql://127.0.0.1/db')).toEqual(['postgresql://127.0.0.1/db']);
  });

  it('redacts an accepted encoded password in both its raw and its decoded form', () => {
    // Four decoded characters, the shortest the configuration accepts.
    const url = 'postgresql://app:%41%42%43%44@127.0.0.1:5432/cas';
    const secrets = connectionSecrets(url);
    expect(secrets).toContain('%41%42%43%44');
    expect(secrets).toContain('ABCD');
    const redact = createRedactor(secrets);
    const line = 'file=report-%41%42%43%44.csv label=ABCD';
    const out = redact(line);
    expect(out).not.toContain('%41%42%43%44');
    expect(out).not.toContain('ABCD');
    expect(out).toBe(`file=report-${REDACTED}.csv label=${REDACTED}`);
  });

  it('protects every password the configuration accepts, because none is shorter than four characters', () => {
    for (const [raw, decoded] of [
      ['abcd', 'abcd'],
      ['p%40ss-marker', 'p@ss-marker'],
      ['%41%42%43%44', 'ABCD'],
    ] as const) {
      const url = `postgresql://app:${raw}@127.0.0.1:5432/cas`;
      const redact = createRedactor(connectionSecrets(url));
      expect(redact(`x ${raw} y`), raw).not.toContain(raw);
      expect(redact(`x ${decoded} y`), decoded).not.toContain(decoded);
    }
  });
});
