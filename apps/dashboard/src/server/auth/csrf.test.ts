import { describe, expect, it } from 'vitest';

import { isDashboardError } from '../errors.ts';
import { assertCsrfToken, assertSameOrigin } from './csrf.ts';
import { csrfTokenFor, generateSessionToken } from './tokens.ts';

const refused = (fn: () => void, code: string): void => {
  try {
    fn();
  } catch (error) {
    expect(isDashboardError(error) && error.kind === 'authorization' && error.code === code).toBe(
      true,
    );
    return;
  }
  throw new Error(`expected refusal ${code}`);
};

describe('same-origin enforcement', () => {
  it('accepts a same-origin request by either signal', () => {
    expect(() =>
      assertSameOrigin(new Headers({ 'sec-fetch-site': 'same-origin' }), 'localhost:3000'),
    ).not.toThrow();
    expect(() =>
      assertSameOrigin(new Headers({ origin: 'http://localhost:3000' }), 'localhost:3000'),
    ).not.toThrow();
    expect(() =>
      assertSameOrigin(
        new Headers({ origin: 'https://dash.example', 'sec-fetch-site': 'same-origin' }),
        'dash.example',
      ),
    ).not.toThrow();
  });

  it('refuses cross-site, foreign-origin, ambient and hostless requests', () => {
    refused(
      () => assertSameOrigin(new Headers({ 'sec-fetch-site': 'cross-site' }), 'localhost:3000'),
      'cross_site',
    );
    refused(
      () =>
        assertSameOrigin(
          new Headers({ 'sec-fetch-site': 'same-site', origin: 'http://localhost:3000' }),
          'localhost:3000',
        ),
      'cross_site',
    );
    refused(
      () => assertSameOrigin(new Headers({ origin: 'https://evil.example' }), 'localhost:3000'),
      'foreign_origin',
    );
    refused(
      () => assertSameOrigin(new Headers({ origin: 'null' }), 'localhost:3000'),
      'foreign_origin',
    );
    refused(() => assertSameOrigin(new Headers(), 'localhost:3000'), 'origin_unknown');
    refused(
      () => assertSameOrigin(new Headers({ referer: 'http://localhost:3000/x' }), 'localhost:3000'),
      'origin_unknown',
    );
    refused(
      () => assertSameOrigin(new Headers({ 'sec-fetch-site': 'same-origin' }), null),
      'host_missing',
    );
    refused(
      () => assertSameOrigin(new Headers({ 'sec-fetch-site': 'same-origin' }), 'bad host!'),
      'host_missing',
    );
  });
});

describe('session-bound CSRF token', () => {
  it('accepts the derived token and refuses anything else', () => {
    const session = generateSessionToken();
    expect(() => assertCsrfToken(session, csrfTokenFor(session))).not.toThrow();
    refused(() => assertCsrfToken(session, csrfTokenFor(generateSessionToken())), 'csrf_mismatch');
    refused(() => assertCsrfToken(session, ''), 'csrf_missing');
    refused(() => assertCsrfToken(session, null), 'csrf_missing');
    refused(() => assertCsrfToken(session, session), 'csrf_mismatch');
  });
});
