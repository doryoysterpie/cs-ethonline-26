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
});
