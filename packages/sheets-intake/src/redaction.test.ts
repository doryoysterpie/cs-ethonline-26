import { describe, expect, it } from 'vitest';

import { hasControlCharacter, safeDisplay } from './display.js';
import { REDACTED, createRedactor, stableDigest } from './redact.js';
import { AUTHORIZED_ID } from './test-support.js';

/**
 * What must never leave, and what must never forge a line.
 *
 * The encoded-form cases are the point of this file. A redactor that catches
 * the raw value and nothing else is a redactor that fails exactly when it
 * matters, because a value that reached a log through a URL, a JSON body or a
 * base64 envelope arrived encoded.
 */

const PRIVATE_KEY_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ';
const SYNTHETIC_PEM = `-----BEGIN PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\n-----END PRIVATE KEY-----`;

describe('credentials and their encoded forms are redacted', () => {
  const redact = createRedactor([AUTHORIZED_ID, PRIVATE_KEY_BODY]);

  it('redacts a raw secret', () => {
    expect(redact(`read ${AUTHORIZED_ID} ok`)).toBe(`read ${REDACTED} ok`);
  });

  it('redacts a percent-encoded secret', () => {
    const encoded = encodeURIComponent(AUTHORIZED_ID);
    expect(redact(`GET /v4/spreadsheets/${encoded}`)).not.toContain(encoded);
    expect(redact(`GET /v4/spreadsheets/${encoded}`)).toContain(REDACTED);
  });

  it('redacts a base64 and a base64url secret', () => {
    for (const encoding of ['base64', 'base64url', 'hex'] as const) {
      const encoded = Buffer.from(AUTHORIZED_ID, 'utf8').toString(encoding);
      const out = redact(`payload=${encoded}`);
      expect(out, encoding).not.toContain(encoded);
      expect(out, encoding).toContain(REDACTED);
    }
  });

  it('redacts a secret whatever its case', () => {
    expect(redact(AUTHORIZED_ID.toLowerCase())).toBe(REDACTED);
  });

  it('redacts a PEM private key even when it was never registered', () => {
    const out = createRedactor([])(`key follows:\n${SYNTHETIC_PEM}\ndone`);
    expect(out).not.toContain('BEGIN PRIVATE KEY');
    expect(out).not.toContain(PRIVATE_KEY_BODY);
    expect(out).toContain(REDACTED);
  });

  it('redacts a bearer token and a Google access token by shape', () => {
    const out = createRedactor([])('authorization: Bearer ya29.a0AfH6SMB-synthetic-token-value');
    expect(out).not.toContain('ya29.');
    expect(out).not.toContain('synthetic-token-value');
  });

  it('redacts a spreadsheet URL whatever identifier it carries', () => {
    const out = createRedactor([])(
      'see https://docs.google.com/spreadsheets/d/SomeOtherIdentifier0000000000/edit#gid=0',
    );
    expect(out).not.toContain('SomeOtherIdentifier0000000000');
    expect(out).toContain('https://docs.google.com/spreadsheets/d/[REDACTED]');
  });

  it('redacts an identifier that reached a log through a key-value assignment', () => {
    const out = createRedactor([])('{"spreadsheetId":"UnregisteredIdentifier00000000000"}');
    expect(out).not.toContain('UnregisteredIdentifier00000000000');
  });

  it('ignores a needle too short to redact without destroying the text', () => {
    // A four-character secret would match ordinary words everywhere; redacting
    // it would hide the message instead of the secret.
    const out = createRedactor(['abcd'])('abcd appears inside abcdefgh and dcba');
    expect(out).toBe('abcd appears inside abcdefgh and dcba');
  });

  it('redacts the longer of two overlapping secrets first', () => {
    const long = 'SyntheticSecretValueLong';
    const short = 'SyntheticSecret';
    const out = createRedactor([short, long])(`value=${long}`);
    expect(out).toBe(`value=${REDACTED}`);
  });

  it('produces a stable, short, non-reversible label', () => {
    const digest = stableDigest(AUTHORIZED_ID);
    expect(digest).toMatch(/^[0-9a-f]{12}$/);
    expect(digest).toBe(stableDigest(AUTHORIZED_ID));
    expect(digest).not.toBe(stableDigest(`${AUTHORIZED_ID}x`));
    expect(AUTHORIZED_ID).not.toContain(digest);
  });
});

describe('hostile workbook text cannot forge a line', () => {
  const hostile = [
    ['newline', `Week 41\ninventory: tabs=0 warnings=0`],
    ['carriage return', `Week 41\rinventory: OK`],
    ['ANSI escape', `Week 41${String.fromCharCode(0x1b)}[2Kforged`],
    ['eight-bit CSI', `Week 41${String.fromCharCode(0x9b)}2Kforged`],
    ['line separator', `Week 41${String.fromCharCode(0x2028)}forged`],
    ['paragraph separator', `Week 41${String.fromCharCode(0x2029)}forged`],
    ['NUL', `Week 41${String.fromCharCode(0x00)}forged`],
    ['DEL', `Week 41${String.fromCharCode(0x7f)}forged`],
  ] as const;

  it.each(hostile)('renders a tab name carrying a %s as one line', (_name, value) => {
    const rendered = safeDisplay(value);
    expect(hasControlCharacter(value)).toBe(true);
    expect(hasControlCharacter(rendered)).toBe(false);
    expect(rendered.split('\n')).toHaveLength(1);
    expect(rendered).toContain('Week 41');
  });

  it('shows what was escaped rather than dropping it', () => {
    expect(safeDisplay('a\nb')).toBe('a\\nb');
    expect(safeDisplay('a\tb')).toBe('a\\tb');
    expect(safeDisplay(`a${String.fromCharCode(0x1b)}b`)).toBe('a\\x1bb');
    expect(safeDisplay(`a${String.fromCharCode(0x2028)}b`)).toBe('a\\u2028b');
  });

  it('bounds a very long name with a visible marker', () => {
    const rendered = safeDisplay('x'.repeat(500), 50);
    expect(rendered.length).toBeLessThan(80);
    expect(rendered).toContain('[+450 chars]');
  });

  it('leaves ordinary text exactly as it was', () => {
    for (const value of ['Cyberattack Sunday 2026-06-21', 'RSS Feed', 'Week 41 — candidates']) {
      expect(safeDisplay(value)).toBe(value);
    }
  });
});
